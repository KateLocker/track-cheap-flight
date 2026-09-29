import axios from "axios";
import { addDays, format } from "date-fns";
import type { SearchConfig } from "./config";
import { SearchBudget, sampleDepartureDates, sampleNights, dateText, matchesAirlines, calendarNights } from "./search-budget";

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
  itineraryComplete?: boolean;
  isNonStop?: boolean;
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
  query: string,
  budget = new SearchBudget(1)
): Promise<SkyscannerPlace | null> {
  const url = `${BASE}/flights/searchAirport`;
  const q: Record<string, unknown> = {
    query,
    locale: MARKET,
  };
  try {
    const resp = await budget.request(options => axios.get(url, {
      ...options,
      params: q,
      headers: getHeaders(apiKey),
    }));
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
  },
  budget = new SearchBudget(1)
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
    const resp = await budget.request(options => axios.get(url, {
      ...options,
      params: q,
      headers: getHeaders(apiKey),
    }));
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
  },
  budget = new SearchBudget(1)
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
    const resp = await budget.request(options => axios.get(url, {
      ...options,
      params: q,
      headers: getHeaders(apiKey),
    }));
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
    if (!data?.status || !data?.data?.itineraries) { budget.warn("供应商未返回有效航班结果。"); return []; }
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
        segments: leg.segments,
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
  },
  budget = new SearchBudget(1)
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
    const resp = await budget.request(options => axios.get(url, {
      ...options,
      params: q,
      headers: getHeaders(apiKey),
    }));
    const data = resp.data as any;
    if (!data?.status || !data?.data?.itineraries) { budget.warn("供应商未返回有效航班结果。"); return []; }
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
        segments: leg.segments,
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

function legCarrierIatas(leg?: NonNullable<SkyscannerFlight["legs"]>[number]): string[] {
  if (!leg) return [];
  const out = new Set<string>();
  for (const c of leg.carriers || []) {
    out.add(c.iata ? c.iata.toUpperCase() : "?");
  }
  return out.size ? Array.from(out) : ["?"];
}

function collectAllAirlines(f: SkyscannerFlight): string[] {
  const set = new Set<string>();
  for (const leg of f.legs || []) {
    for (const iata of legCarrierIatas(leg)) set.add(iata);
  }
  return Array.from(set);
}

export async function searchRoundTripFlexible(
  apiKey: string, cfg: SearchConfig,
  budget = new SearchBudget(cfg.mode === "light" ? 10 : 16)
): Promise<SkyscannerRoundTrip[]> {
  const results: SkyscannerRoundTrip[] = [];
  const fromPlace = await lookupPlace(apiKey, cfg.flyFrom, budget);
  if (!budget.checkTime()) return results;
  const toPlace = await lookupPlace(apiKey, cfg.flyTo, budget);
  if (!fromPlace || !toPlace) {
    budget.warn("无法确认出发或到达机场。");
    return results;
  }
  const dates = sampleDepartureDates(cfg.searchDaysAhead, budget.remainingRequests);
  const nights = sampleNights(cfg.minNights, cfg.maxNights);
  const seen = new Set<string>();
  for (let i = 0; i < dates.length && budget.checkTime(); i++) {
    const n = nights[i % nights.length];
    const d1 = dateText(dates[i]);
    const d2 = dateText(addDays(dates[i], n));
    budget.recordDate(d1);
    const flights = await searchSkyscannerRoundTripDirect(apiKey, {
      originSkyId: fromPlace.skyId, destinationSkyId: toPlace.skyId,
      originEntityId: fromPlace.entityId, destinationEntityId: toPlace.entityId,
      departDate: d1, returnDate: d2, adults: cfg.adults,
    }, budget);
    for (const f of flights) {
      if (!Number.isFinite(f.price) || !f.price || f.price <= 0 || (cfg.maxPriceJPY != null && f.price > cfg.maxPriceJPY)) continue;
      const outLeg = f.legs?.[0];
      const inLeg = f.legs?.[1];
      if (!outLeg) continue;
      const airlines = collectAllAirlines(f);
      const complete = !!(outLeg.departure && inLeg?.departure);
      // This provider's documented response has stopCount; no unverified query parameter is assumed.
      const isNonStop = complete && f.legs?.length === 2 && f.legs.every(leg => {
        if (leg.stopCount !== 0) return false;
        if (leg.segments === undefined) return true;
        if (!Array.isArray(leg.segments) || leg.segments.length !== 1) return false;
        const segment = leg.segments[0];
        if (!segment || typeof segment !== "object") return false;
        const details = segment as Record<string, unknown>;
        return [details.stopCount, details.numberOfStops].every(count => count === undefined || count === 0)
          && (details.stops === undefined || details.stops === 0 || (Array.isArray(details.stops) && details.stops.length === 0));
      });
      if (cfg.nonStopOnly && !isNonStop) continue;
      if (cfg.selectAirlines.length && (!complete || !matchesAirlines(airlines, cfg.selectAirlines))) continue;
      const outDep = outLeg.departure || d1;
      const retDep = inLeg?.departure || d2;
      const actualNights = calendarNights(outDep, retDep);
      if (actualNights < cfg.minNights || actualNights > cfg.maxNights) continue;
      const key = f.id || JSON.stringify([outDep, retDep, airlines, f.price]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!complete) budget.warn("部分报价的返程时刻未确认。");
      results.push({
        id: key, price: f.price, currency: "JPY", flyFrom: cfg.flyFrom, flyTo: cfg.flyTo,
        cityFrom: fromPlace.name, cityTo: toPlace.name, local_departure: outDep,
        local_arrival: outLeg.arrival || "", return_departure: retDep, return_arrival: inLeg?.arrival || "",
        airlines, nightsInDest: actualNights, deep_link: f.deep_link || "", booking_token: f.id || "",
        route: f.legs || [], itineraryComplete: complete, isNonStop,
      });
    }
  }
  return results.sort((a, b) => a.price - b.price);
}
