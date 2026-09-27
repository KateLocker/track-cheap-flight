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
        mode: "light" as const,
      };
      const r = await serpSearch(cfg.serpApiKey, searchCfg);
      out.test.serpapi_light_NRT_DLC = {
        count: r.length,
        sample: r.slice(0, 3).map((f: any) => ({ price: f.price, airlines: f.airlines, nights: f.nightsInDest })),
      };
    } catch (e: any) {
      out.test.serpapi_light_NRT_DLC = {
        ok: false,
        error: e?.message || String(e),
        stack: e?.stack?.slice(0, 300),
      };
    }
  }

  return NextResponse.json(out);
}
