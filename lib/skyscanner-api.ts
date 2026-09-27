import axios from "axios";
import { addDays, format } from "date-fns";
import type { SearchConfig } from "./config";

export interface SkyscannerPlace {
  skyId: string;
  entityId: string;
  name: string;
  iata?: string;
  type?: string;
}

export interface SkyscannerFlight {
  id?: string;
  price?: number;
  legs?: Array<{
    id?: string;
    origin?: { id?: string; iata?: string; name?: string; entityId?: string };
    destination?: { id?: string; iata?: string; name?: string; entityId?: string };
    departure?: string;
    arrival?: string;
    durationInMinutes?: number;
    stopCount?: number;
    carriers?: Array<{ id?: string; name?: string; iata?: string; imageUrl?: string; alt?: string }>;
    segments?: unknown[];
  }>;
  deep_link?: string;
}

export interface SkyscannerRoundTrip {
  id: string;
  price: number;
  currency: string;
  flyFrom: string;
  flyTo: string;
  cityFrom: string;
  cityTo: string;
  local_departure: string;
  local_arrival: string;
  return_departure: string;
  return_arrival: string;
  airlines: string[];
  nightsInDest: number;
  deep_link: string;
  booking_token: string;
  route: unknown[];
}

export interface PriceCalendarDay {
  date: string;
  price: number;
  isMonth?: boolean;
}

const MARKET = "ja-JP";
const COUNTRY_CODE = "JP";
const CURRENCY = "JPY";
const HOST = "sky-scrapper.p.rapidapi.com";
const BASE = `https://${HOST}/api/v1`;

function getHeaders(key: string): Record<string, string> {
  return {
    "x-rapidapi-key": key,
    "x-rapidapi-host": HOST,
  };
}

export async function lookupPlace(
  apiKey: string,
  query: string
): Promise<SkyscannerPlace | null> {
  const url = `${BASE}/flights/searchAirport`;
  const q: Record<string, unknown> = {
    query,
    locale: MARKET,
  };
  try {
    const resp = await axios.get(url, {
      params: q,
      headers: getHeaders(apiKey),
      timeout: 30_000,
    });
    const data = resp.data as {
      status?: boolean;
      data?: Array<{
        skyId?: string;
        entityId?: string;
        presentation?: { title?: string; suggestionTitle?: string };
        navigation?: { localizedName?: string; relevantFlightParams?: { skyId?: string; entityId?: string } };
        iata?: string;
      }>;
    };
    if (!data?.status || !Array.isArray(data.data) || data.data.length === 0) return null;
    const exact = data.data.find(
      (p: any) =>
        (p.iata && p.iata.toUpperCase() === query.toUpperCase()) ||
        (p.navigation?.relevantFlightParams?.skyId &&
          p.navigation.relevantFlightParams.skyId.toUpperCase() === query.toUpperCase()) ||
        (p.skyId && p.skyId.toUpperCase() === query.toUpperCase())
    );
    const pick = exact || data.data[0];
    const skyId = pick.skyId || pick.navigation?.relevantFlightParams?.skyId;
    const entityId = pick.entityId || pick.navigation?.relevantFlightParams?.entityId;
    if (!skyId || !entityId) return null;
    return {
      skyId,
      entityId,
      name: pick.presentation?.suggestionTitle || pick.presentation?.title || pick.navigation?.localizedName || query,
      iata: pick.iata,
    };
  } catch {
    return null;
  }
}

export async function getPriceCalendar(
  apiKey: string,
  params: {
    originSkyId: string;
    destinationSkyId: string;
    fromDate: string;
    toDate: string;
  }
): Promise<PriceCalendarDay[]> {
  const url = `${BASE}/flights/getPriceCalendar`;
  const q: Record<string, unknown> = {
    originSkyId: params.originSkyId,
    destinationSkyId: params.destinationSkyId,
    fromDate: params.fromDate,
    toDate: params.toDate,
    currency: CURRENCY,
    countryCode: COUNTRY_CODE,
    market: MARKET,
  };
  try {
    const resp = await axios.get(url, {
      params: q,
      headers: getHeaders(apiKey),
      timeout: 60_000,
    });
    const data = resp.data as {
      status?: boolean;
      data?: {
        flights?: {
          days?: Array<{ day?: string; price?: number; isMonth?: boolean }>;
        };
      };
    };
    if (!data?.status || !data?.data?.flights?.days) return [];
    const out: PriceCalendarDay[] = [];
    for (const d of data.data.flights.days) {
      if (d && d.day && typeof d.price === "number" && d.price > 0) {
        out.push({ date: d.day, price: d.price, isMonth: !!d.isMonth });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function searchSkyscannerOneWay(
  apiKey: string,
  params: {
    originSkyId: string;
    destinationSkyId: string;
    originEntityId: string;
    destinationEntityId: string;
    date: string;
    adults?: number;
    cabinClass?: "economy" | "premium_economy" | "business" | "first";
  }
): Promise<SkyscannerFlight[]> {
  const url = `${BASE}/flights/searchFlights`;
  const q: Record<string, unknown> = {
    originSkyId: params.originSkyId,
    destinationSkyId: params.destinationSkyId,
    originEntityId: params.originEntityId,
    destinationEntityId: params.destinationEntityId,
    date: params.date,
    adults: String(params.adults ?? 1),
    cabinClass: params.cabinClass ?? "economy",
    currency: CURRENCY,
    countryCode: COUNTRY_CODE,
    market: MARKET,
  };
  try {
    const resp = await axios.get(url, {
      params: q,
      headers: getHeaders(apiKey),
      timeout: 90_000,
    });
    const data = resp.data as {
      status?: boolean;
      data?: {
        itineraries?: Array<{
          id?: string;
          price?: { raw?: number; formatted?: string };
          legs?: Array<{
            id?: string;
            origin?: { id?: string; iata?: string; name?: string };
            destination?: { id?: string; iata?: string; name?: string };
            departure?: string;
            arrival?: string;
            durationInMinutes?: number;
            stopCount?: number;
            carriers?: Array<{ id?: string; name?: string; iata?: string; marketing?: Array<{ name?: string; iata?: string }> }>;
          }>;
          deep_link?: string;
          bookingOptions?: unknown;
        }>;
      };
      context?: { status?: string; totalItineraries?: number };
    };
    if (!data?.status || !data?.data?.itineraries) return [];
    return data.data.itineraries.slice(0, 15).map((it: any) => ({
      id: it.id,
      price: it.price?.raw,
      deep_link: it.deep_link,
      legs: (it.legs || []).map((leg: any) => ({
        id: leg.id,
        origin: leg.origin,
        destination: leg.destination,
        departure: leg.departure,
        arrival: leg.arrival,
        durationInMinutes: leg.durationInMinutes,
        stopCount: leg.stopCount,
        carriers: (leg.carriers?.marketing || leg.carriers || []).map((c: any) => ({
          name: c.name,
          iata: c.iata,
          imageUrl: c.logoUrl || c.imageUrl,
        })),
      })),
    }));
  } catch {
    return [];
  }
}

export async function searchSkyscannerRoundTripDirect(
  apiKey: string,
  params: {
    originSkyId: string;
    destinationSkyId: string;
    originEntityId: string;
    destinationEntityId: string;
    departDate: string;
    returnDate: string;
    adults?: number;
    cabinClass?: "economy" | "premium_economy" | "business" | "first";
  }
): Promise<SkyscannerFlight[]> {
  const url = `${BASE}/flights/searchFlights`;
  const q: Record<string, unknown> = {
    originSkyId: params.originSkyId,
    destinationSkyId: params.destinationSkyId,
    originEntityId: params.originEntityId,
    destinationEntityId: params.destinationEntityId,
    date: params.departDate,
    returnDate: params.returnDate,
    adults: String(params.adults ?? 1),
    cabinClass: params.cabinClass ?? "economy",
    currency: CURRENCY,
    countryCode: COUNTRY_CODE,
    market: MARKET,
  };
  try {
    const resp = await axios.get(url, {
      params: q,
      headers: getHeaders(apiKey),
      timeout: 120_000,
    });
    const data = resp.data as any;
    if (!data?.status || !data?.data?.itineraries) return [];
    return (data.data.itineraries as any[]).slice(0, 15).map((it: any) => ({
      id: it.id,
      price: it.price?.raw,
      deep_link: it.deep_link,
      legs: (it.legs || []).map((leg: any) => ({
        id: leg.id,
        origin: leg.origin,
        destination: leg.destination,
        departure: leg.departure,
        arrival: leg.arrival,
        durationInMinutes: leg.durationInMinutes,
        stopCount: leg.stopCount,
        carriers: (leg.carriers?.marketing || leg.carriers || []).map((c: any) => ({
          name: c.name,
          iata: c.iata,
          imageUrl: c.logoUrl || c.imageUrl,
        })),
      })),
    }));
  } catch {
    return [];
  }
}

function legCarrierIatas(leg?: SkyscannerFlight["legs"][number]): string[] {
  if (!leg) return [];
  const out = new Set<string>();
  for (const c of leg.carriers || []) {
    if (c.iata) out.add(c.iata.toUpperCase());
  }
  return Array.from(out);
}

function collectAllAirlines(f: SkyscannerFlight): string[] {
  const set = new Set<string>();
  for (const leg of f.legs || []) {
    for (const iata of legCarrierIatas(leg)) set.add(iata);
  }
  return Array.from(set);
}

export async function searchRoundTripFlexible(
  apiKey: string,
  cfg: SearchConfig
): Promise<SkyscannerRoundTrip[]> {
  const out: SkyscannerRoundTrip[] = [];
  const seen = new Set<string>();

  const fromPlace = await lookupPlace(apiKey, cfg.flyFrom);
  const toPlace = await lookupPlace(apiKey, cfg.flyTo);
  if (!fromPlace || !toPlace) return [];

  const today = new Date();
  const startOut = addDays(today, Math.min(14, Math.max(7, Math.floor(cfg.searchDaysAhead / 6))));
  const endOut = addDays(today, cfg.searchDaysAhead);

  const startStr = format(startOut, "yyyy-MM-dd");
  const endStr = format(endOut, "yyyy-MM-dd");

  const outboundCal = await getPriceCalendar(apiKey, {
    originSkyId: fromPlace.skyId,
    destinationSkyId: toPlace.skyId,
    fromDate: startStr,
    toDate: endStr,
  });

  outboundCal.sort((a, b) => a.price - b.price);
  const cheapOutbounds = outboundCal.slice(0, 5);

  let dCandidates: { depart: Date; priceEst: number }[] = [];
  if (cheapOutbounds.length > 0) {
    for (const d of cheapOutbounds) {
      const dt = new Date(d.date + "T00:00:00");
      if (!isNaN(dt.getTime())) dCandidates.push({ depart: dt, priceEst: d.price });
    }
  } else {
    const step = Math.max(5, Math.ceil(cfg.searchDaysAhead / 6));
    for (let i = 0; i < 6; i++) {
      const dt = addDays(startOut, step * i);
      if (dt > endOut) break;
      dCandidates.push({ depart: dt, priceEst: 0 });
    }
  }

  let apiCallsLeft = 5;
  if (cfg.mode === "light") apiCallsLeft = 3;

  for (const { depart } of dCandidates) {
    if (apiCallsLeft <= 0) break;
    const minReturn = addDays(depart, cfg.minNights);
    const maxReturn = addDays(depart, cfg.maxNights);
    const tryReturns: Date[] = [];
    const midNights = Math.floor((cfg.minNights + cfg.maxNights) / 2);
    tryReturns.push(addDays(depart, cfg.minNights));
    tryReturns.push(addDays(depart, midNights));
    tryReturns.push(addDays(depart, cfg.maxNights));
    for (const ret of tryReturns) {
      if (ret < minReturn || ret > maxReturn) continue;
      if (apiCallsLeft <= 0) break;
      apiCallsLeft--;
      const d1 = format(depart, "yyyy-MM-dd");
      const d2 = format(ret, "yyyy-MM-dd");
      const flights = await searchSkyscannerRoundTripDirect(apiKey, {
        originSkyId: fromPlace.skyId,
        destinationSkyId: toPlace.skyId,
        originEntityId: fromPlace.entityId,
        destinationEntityId: toPlace.entityId,
        departDate: d1,
        returnDate: d2,
        adults: cfg.adults,
      });
      for (const f of flights) {
        const price = f.price;
        if (!price || price <= 0) continue;
        if (cfg.maxPriceJPY != null && price > cfg.maxPriceJPY) continue;
        const outLeg = f.legs?.[0];
        const inLeg = f.legs?.[1];
        if (!outLeg) continue;
        const allAir = collectAllAirlines(f);
        if (cfg.selectAirlines && cfg.selectAirlines.length > 0) {
          const matched = cfg.selectAirlines.some(
            (c) => allAir.includes(c.toUpperCase())
          );
          if (!matched) continue;
        }
        const outDep = outLeg.departure || `${d1}T12:00:00`;
        const outArr = outLeg.arrival || outDep;
        const retDep = inLeg?.departure || `${d2}T12:00:00`;
        const retArr = inLeg?.arrival || retDep;
        const outD = new Date(outDep);
        const retD = new Date(retDep);
        const nights = Math.max(
          0,
          Math.round((retD.getTime() - outD.getTime()) / (1000 * 60 * 60 * 24))
        );
        if (nights < cfg.minNights || nights > cfg.maxNights) continue;
        const key = `${format(outD, "yyyyMMdd")}|${format(retD, "yyyyMMdd")}|${allAir.join(
          ","
        )}|${Math.floor(price / 1000)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: key,
          price: Math.round(price),
          currency: "JPY",
          flyFrom: cfg.flyFrom,
          flyTo: cfg.flyTo,
          cityFrom: fromPlace.name || cfg.flyFrom,
          cityTo: toPlace.name || cfg.flyTo,
          local_departure: outDep,
          local_arrival: outArr,
          return_departure: retDep,
          return_arrival: retArr,
          airlines: allAir.length ? allAir : ["?"],
          nightsInDest: nights,
          deep_link: f.deep_link || "",
          booking_token: f.id || key,
          route: (f.legs || []).slice(0, 8),
        });
      }
    }
  }

  out.sort((a, b) => a.price - b.price);
  return out;
}
