import axios from "axios";
import { addDays, format } from "date-fns";
import type { SearchConfig } from "./config";

export interface SkyscannerFlight {
  id?: string;
  price?: { amount?: number; unit?: string; updateStatus?: string };
  legs?: Array<{
    id?: string;
    origin?: { iata?: string; name?: string; entityId?: string };
    destination?: { iata?: string; name?: string; entityId?: string };
    departure?: string;
    arrival?: string;
    durationInMinutes?: number;
    stopCount?: number;
    carriers?: Array<{ id?: string; name?: string; iata?: string; imageUrl?: string }>;
    segments?: unknown[];
  }>;
}

export interface SkyscannerCreateSessionResp {
  sessionToken?: string;
  status?: string;
  content?: {
    results?: {
      itineraries?: SkyscannerFlight[];
    };
    sortingOptions?: unknown;
    filters?: unknown;
  };
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

const MARKET = "JP";
const LOCALE = "ja-JP";
const CURRENCY = "JPY";
const BASE = "https://skyscanner80.p.rapidapi.com/api/v1";

function getHeaders(key: string): Record<string, string> {
  return {
    "x-rapidapi-key": key,
    "x-rapidapi-host": "skyscanner80.p.rapidapi.com",
  };
}

export async function searchSkyscannerOneWay(
  apiKey: string,
  params: {
    fromEntityId: string;
    toEntityId: string;
    departDate: string;
    adults?: number;
    cabinClass?: "economy" | "premium_economy" | "business" | "first";
    maxEntries?: number;
  }
): Promise<SkyscannerFlight[]> {
  const url = `${BASE}/flights/search-one-way`;
  const q: Record<string, unknown> = {
    fromId: params.fromEntityId,
    toId: params.toEntityId,
    departDate: params.departDate,
    adults: String(params.adults ?? 1),
    cabinClass: params.cabinClass ?? "economy",
    currency: CURRENCY,
    market: MARKET,
    locale: LOCALE,
  };
  const resp = await axios.get(url, {
    params: q,
    headers: getHeaders(apiKey),
    timeout: 60_000,
  });
  const data = resp.data as {
    data?: {
      itineraries?: SkyscannerFlight[];
    };
    status?: string;
  };
  return (data?.data?.itineraries || []).slice(0, params.maxEntries ?? 15);
}

export async function searchSkyscannerRoundTripDirect(
  apiKey: string,
  params: {
    fromEntityId: string;
    toEntityId: string;
    departDate: string;
    returnDate: string;
    adults?: number;
    cabinClass?: "economy" | "premium_economy" | "business" | "first";
  }
): Promise<SkyscannerFlight[]> {
  const url = `${BASE}/flights/search-roundtrip`;
  const q: Record<string, unknown> = {
    fromId: params.fromEntityId,
    toId: params.toEntityId,
    departDate: params.departDate,
    returnDate: params.returnDate,
    adults: String(params.adults ?? 1),
    cabinClass: params.cabinClass ?? "economy",
    currency: CURRENCY,
    market: MARKET,
    locale: LOCALE,
  };
  const resp = await axios.get(url, {
    params: q,
    headers: getHeaders(apiKey),
    timeout: 90_000,
  });
  const data = resp.data as {
    data?: {
      itineraries?: SkyscannerFlight[];
    };
    status?: string;
  };
  return data?.data?.itineraries || [];
}

function firstAirlineIata(f: SkyscannerFlight, legIdx: number): string {
  const carriers = f.legs?.[legIdx]?.carriers || [];
  for (const c of carriers) {
    if (c.iata) return c.iata;
  }
  return "?";
}

function collectAirlines(f: SkyscannerFlight): string[] {
  const set = new Set<string>();
  for (const leg of f.legs || []) {
    for (const c of leg.carriers || []) {
      if (c.iata) set.add(c.iata);
    }
  }
  return Array.from(set);
}

async function _searchFlexibleRoundTripViaRoundTripDirect(
  apiKey: string,
  cfg: SearchConfig
): Promise<SkyscannerRoundTrip[]> {
  const out: SkyscannerRoundTrip[] = [];
  const seen = new Set<string>();
  const today = new Date();
  const maxDepart = addDays(today, cfg.searchDaysAhead);
  const stepDays = Math.min(10, Math.max(5, Math.ceil(cfg.searchDaysAhead / 10)));
  let cur = addDays(today, 7);
  let iter = 0;
  while (cur < maxDepart && iter < 6) {
    iter++;
    const depart = new Date(cur);
    const minReturn = addDays(depart, cfg.minNights);
    const maxReturn = addDays(depart, cfg.maxNights);
    const tryReturnDates: Date[] = [];
    let r = new Date(minReturn);
    while (r <= maxReturn && tryReturnDates.length < 3) {
      tryReturnDates.push(new Date(r));
      r = addDays(r, 3);
    }
    for (const ret of tryReturnDates) {
      try {
        const res = await searchSkyscannerRoundTripDirect(apiKey, {
          fromEntityId: cfg.flyFrom,
          toEntityId: cfg.flyTo,
          departDate: format(depart, "yyyy-MM-dd"),
          returnDate: format(ret, "yyyy-MM-dd"),
          adults: cfg.adults,
        });
        for (const f of res) {
          const price = f.price?.amount;
          if (!price || price <= 0) continue;
          if (cfg.maxPriceJPY != null && price > cfg.maxPriceJPY) continue;
          const outLeg = f.legs?.[0];
          const inLeg = f.legs?.[1] || f.legs?.[0];
          if (!outLeg) continue;
          const outAir = firstAirlineIata(f, 0);
          const retAir = firstAirlineIata(f, 1);
          if (cfg.selectAirlines.length > 0) {
            const all = collectAirlines(f);
            const hasMatch = cfg.selectAirlines.some(
              (c) => outAir === c || retAir === c || all.includes(c)
            );
            if (!hasMatch) continue;
          }
          const outDep = outLeg.departure || ret?.toISOString();
          const outArr = outLeg.arrival || outDep;
          const retDep = inLeg?.departure || ret?.toISOString();
          const retArr = inLeg?.arrival || retDep;
          const outD = new Date(outDep);
          const retD = new Date(retDep);
          const nights = Math.max(
            0,
            Math.round(
              (retD.getTime() - outD.getTime()) / (1000 * 60 * 60 * 24)
            )
          );
          if (nights < cfg.minNights || nights > cfg.maxNights) continue;
          const key = `${format(outD, "yyyyMMdd")}|${format(retD, "yyyyMMdd")}|${outAir}|${retAir}|${Math.floor(price / 1000)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            id: key,
            price: Math.round(price),
            currency: "JPY",
            flyFrom: cfg.flyFrom,
            flyTo: cfg.flyTo,
            cityFrom: cfg.flyFrom,
            cityTo: cfg.flyTo,
            local_departure: outDep,
            local_arrival: outArr,
            return_departure: retDep,
            return_arrival: retArr,
            airlines: collectAirlines(f).length ? collectAirlines(f) : [outAir, retAir].filter((x) => x && x !== "?"),
            nightsInDest: nights,
            deep_link: "",
            booking_token: f.id || key,
            route: (f.legs || []).slice(0, 8),
          });
        }
      } catch {
        /* ignore */
      }
    }
    cur = addDays(cur, stepDays);
  }
  return out;
}

export async function searchRoundTripFlexible(
  apiKey: string,
  cfg: SearchConfig
): Promise<SkyscannerRoundTrip[]> {
  const r = await _searchFlexibleRoundTripViaRoundTripDirect(apiKey, cfg);
  r.sort((a, b) => a.price - b.price);
  return r;
}
