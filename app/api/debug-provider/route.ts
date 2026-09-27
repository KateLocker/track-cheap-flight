import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import axios from "axios";
import { lookupPlace, getPriceCalendar, searchSkyscannerRoundTripDirect } from "@/lib/skyscanner-api";
import { searchRoundTripFlexible as serpSearch } from "@/lib/google-flights-api";
import { format, addDays } from "date-fns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = loadConfig();
  const out: any = {
    ts: new Date().toISOString(),
    has: {
      rapidapiKey: !!cfg.rapidapiKey,
      rapidapiKeyLen: cfg.rapidapiKey?.length || 0,
      serpApiKey: !!cfg.serpApiKey,
      serpApiKeyLen: cfg.serpApiKey?.length || 0,
      amadeusClientId: !!cfg.amadeusClientId,
      kiwiApiKey: !!cfg.kiwiApiKey,
    },
    searchDefault: cfg.search,
    test: {},
  };

  // --- Sky Scrapper Quick test ---
  if (cfg.rapidapiKey) {
    try {
      const host = "sky-scrapper.p.rapidapi.com";
      const url = `https://${host}/api/v1/checkServer`;
      const r = await axios.get(url, {
        headers: {
          "x-rapidapi-key": cfg.rapidapiKey,
          "x-rapidapi-host": host,
        },
        timeout: 15_000,
      });
      out.test.rapidapi_checkServer = {
        ok: true,
        status: r.status,
        data: typeof r.data === "object" ? JSON.stringify(r.data).slice(0, 500) : String(r.data).slice(0, 500),
      };
    } catch (e: any) {
      out.test.rapidapi_checkServer = {
        ok: false,
        error: e?.message || String(e),
        status: e?.response?.status || null,
        data: e?.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : null,
      };
    }

    try {
      const tokyo = await lookupPlace(cfg.rapidapiKey, "TYO");
      const dalian = await lookupPlace(cfg.rapidapiKey, "DLC");
      out.test.rapidapi_lookup = { tokyo, dalian };
      if (tokyo && dalian) {
        const today = new Date();
        const from = format(addDays(today, 14), "yyyy-MM-dd");
        const to = format(addDays(today, 100), "yyyy-MM-dd");
        const cal = await getPriceCalendar(cfg.rapidapiKey, {
          originSkyId: tokyo.skyId,
          destinationSkyId: dalian.skyId,
          fromDate: from,
          toDate: to,
        });
        out.test.rapidapi_priceCalendar = { count: cal.length, sample: cal.slice(0, 5) };

        const depart = format(addDays(today, 21), "yyyy-MM-dd");
        const ret = format(addDays(today, 28), "yyyy-MM-dd");
        const flights = await searchSkyscannerRoundTripDirect(cfg.rapidapiKey, {
          originSkyId: tokyo.skyId,
          destinationSkyId: dalian.skyId,
          originEntityId: tokyo.entityId,
          destinationEntityId: dalian.entityId,
          departDate: depart,
          returnDate: ret,
          adults: 1,
        });
        out.test.rapidapi_searchRoundTrip = { count: flights.length, samplePrice: flights[0]?.price, sampleAirline: flights[0]?.legs?.[0]?.carriers?.[0]?.name || flights[0]?.legs?.[0]?.carriers?.[0]?.iata };
      }
    } catch (e: any) {
      out.test.rapidapi_skyCall = { ok: false, error: e?.message || String(e), stack: e?.stack?.slice(0, 300) };
    }
  }

  // --- SERP quick test (NRT -> DLC 1 day single one-way) ---
  if (cfg.serpApiKey) {
    try {
      const searchCfg = {
        flyFrom: "NRT",
        flyTo: "DLC",
        searchDaysAhead: 60,
        minNights: 7,
        maxNights: 10,
        adults: 1,
        selectAirlines: [],
        maxPriceJPY: null,
        mode: "full" as const,
      };
      const r = await serpSearch(cfg.serpApiKey, searchCfg);
      out.test.serpapi_light_NRT_DLC_roundtrip = {
        count: r.length,
        sample: r.slice(0, 5).map((f: any) => ({ price: f.price, airlines: f.airlines, nightsInDest: f.nightsInDest, depart: f.local_departure?.slice(0,10), returnDepart: f.return_departure?.slice(0,10), flyFrom: f.flyFrom, flyTo: f.flyTo })),
      };
    } catch (e: any) {
      out.test.serpapi_light_NRT_DLC_roundtrip = {
        ok: false,
        error: e?.message || String(e),
        stack: e?.stack?.slice(0, 300),
      };
    }

    try {
      const { searchGoogleFlightsOneWay } = await import("@/lib/google-flights-api");
      const specificDay = new Date();
      specificDay.setDate(specificDay.getDate() + 21);
      const outs = await searchGoogleFlightsOneWay({
        api_key: cfg.serpApiKey,
        departure_id: "NRT",
        arrival_id: "DLC",
        outbound_date_specific: specificDay,
        currency: "JPY",
        hl: "ja",
        adults: 1,
        travelType: "one_way",
      } as any);
      out.test.serpapi_NRT_DLC_specificOneway = {
        testDate: format(specificDay, "yyyy-MM-dd"),
        count: outs.length,
        samplePrice: outs[0]?.price,
        sampleAirline: outs[0]?.flights?.[0]?.[0]?.airline_code,
      };
    } catch (e: any) {
      out.test.serpapi_NRT_DLC_specificOneway = {
        ok: false,
        error: e?.message || String(e),
        stack: e?.stack?.slice(0, 300),
      };
    }

    // Hard test: NRT->DLC round trip type=1, specific depart + return date, no airline filter
    try {
      const axios_mod = await import("axios");
      const axios = axios_mod.default;
      const departDate = new Date();
      departDate.setDate(departDate.getDate() + 21);
      const returnDate = addDays(departDate, 7);
      const queryParams: Record<string, unknown> = {
        engine: "google_flights",
        api_key: cfg.serpApiKey,
        departure_id: "NRT",
        arrival_id: "DLC",
        outbound_date: format(departDate, "yyyy-MM-dd"),
        return_date: format(returnDate, "yyyy-MM-dd"),
        currency: "JPY",
        hl: "ja",
        adults: 1,
        type: "1",
      };
      const t0 = Date.now();
      const resp = await axios.get("https://serpapi.com/search", { params: queryParams, timeout: 30_000 });
      const data = resp.data as any;
      const pushList = (list: unknown): any[] => {
        if (!Array.isArray(list)) return [];
        const out: any[] = [];
        for (const raw of list) {
          const item: any = raw;
          if (item && typeof item.price === "number") {
            out.push({
              price: item.price,
              airline: item.flights?.[0]?.[0]?.airline_code || (Array.isArray(item.flights) ? item.flights.flat()[0]?.airline_code : null),
              depart: item.flights?.[0]?.[0]?.departure_airport?.time,
              return_depart: item.flights?.[1]?.[0]?.departure_airport?.time,
            });
          }
        }
        return out;
      };
      const all = [...pushList(data.best_flights), ...pushList(data.other_flights), ...pushList(Array.isArray(data.flights) ? data.flights : [])];
      out.test.serpapi_NRT_DLC_specificRoundTrip_hard = {
        departDate: format(departDate, "yyyy-MM-dd"),
        returnDate: format(returnDate, "yyyy-MM-dd"),
        elapsedMs: Date.now() - t0,
        count: all.length,
        sampleLowest: all.sort((a, b) => a.price - b.price).slice(0, 5),
        hasError: !!data?.error,
        error: data?.error || null,
      };
    } catch (e: any) {
      out.test.serpapi_NRT_DLC_specificRoundTrip_hard = {
        ok: false,
        error: e?.message || String(e),
        response: e?.response?.data ? JSON.stringify(e.response.data).slice(0, 1000) : null,
        stack: e?.stack?.slice(0, 300),
      };
    }
  }

  return NextResponse.json(out);
}
