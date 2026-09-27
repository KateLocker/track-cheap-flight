import axios from "axios";
import { format, addDays } from "date-fns";
import type { SearchConfig } from "./config";

export interface GFlightsSegment {
  airline_code: string;
  flight_number?: string;
  departure_airport?: { id?: string; name?: string; time?: string };
  arrival_airport?: { id?: string; name?: string; time?: string };
  duration?: number;
}

export interface GFlightsOption {
  id?: string;
  price: number;
  airline_logo?: string;
  flights: GFlightsSegment[][];
  total_duration?: number;
  layovers?: number;
  departure_token?: string;
  booking_token?: string;
  deep_link?: string;
}

export interface SerpSearchParams {
  api_key: string;
  departure_id: string;
  arrival_id: string;
  outbound_date_start: Date;
  outbound_date_end: Date;
  outbound_date_specific?: Date;
  return_date_specific?: Date;
  airlineCodes?: string[];
  maxPrice?: number;
  adults?: number;
  currency?: string;
  hl?: string;
  travelType?: "one_way" | "round_trip";
}

const SERPAPI_BASE = "https://serpapi.com";

function dateRangeToStr(start: Date, end: Date): string {
  const s = format(start, "yyyy-MM-dd");
  const e = format(end, "yyyy-MM-dd");
  if (s === e) return s;
  return `${s}..${e}`;
}

export async function searchGoogleFlightsOneWay(
  params: SerpSearchParams
): Promise<GFlightsOption[]> {
  const all: GFlightsOption[] = [];
  const tryDates: Date[] = [];
  if (params.outbound_date_specific) {
    tryDates.push(new Date(params.outbound_date_specific));
  } else {
    const start = new Date(params.outbound_date_start);
    const end = new Date(params.outbound_date_end);
    const days = Math.max(
      1,
      Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    );
    let step = 1;
    if (days > 21) step = 3;
    if (days > 60) step = 5;
    if (days > 120) step = 7;
    for (
      let d = new Date(start), i = 0;
      d <= end && i < Math.min(10, Math.ceil(days / step));
      d = addDays(d, step), i++
    ) {
      tryDates.push(new Date(d));
    }
  }

  const maxCallsPerInvoke = 10;
  for (let idx = 0; idx < Math.min(maxCallsPerInvoke, tryDates.length); idx++) {
    const d = tryDates[idx];

    const queryParams: Record<string, unknown> = {
      engine: "google_flights",
      api_key: params.api_key,
      departure_id: params.departure_id,
      arrival_id: params.arrival_id,
      outbound_date: format(d, "yyyy-MM-dd"),
      currency: params.currency ?? "JPY",
      hl: params.hl ?? "ja",
      adults: params.adults ?? 1,
      type: "2",
    };

    if (params.return_date_specific) {
      queryParams.return_date = format(params.return_date_specific, "yyyy-MM-dd");
      queryParams.type = "1";
    }
    if (params.airlineCodes && params.airlineCodes.length > 0) {
      queryParams.airline_codes = params.airlineCodes.join(",");
    }
    if (params.maxPrice && params.maxPrice > 0) {
      queryParams.max_price = params.maxPrice;
    }

    try {
      const resp = await axios.get(SERPAPI_BASE + "/search", {
        params: queryParams,
        timeout: 90_000,
      });
      const data = resp.data as {
        best_flights?: unknown;
        other_flights?: unknown;
        price_insights?: unknown;
        search_metadata?: unknown;
        search_parameters?: unknown;
        error?: unknown;
      };
      if ((data as any).error) continue;

      const out: GFlightsOption[] = [];
      type Item = {
        flights: unknown;
        price: number;
        type?: string;
        deep_link?: string;
        total_duration?: number;
        layovers?: number;
        departure_token?: string;
        booking_token?: string;
      };
      const push = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const raw of list) {
          const item = raw as Item | null | undefined;
          if (!item || !item.price) continue;
          const flightsArr = Array.isArray(item.flights) ? item.flights as GFlightsSegment[][] : null;
          if (!flightsArr) continue;
          out.push({
            price: item.price,
            flights: flightsArr,
            deep_link: item.deep_link,
            total_duration: item.total_duration,
            layovers: item.layovers,
            departure_token: item.departure_token,
            booking_token: item.booking_token,
          });
        }
      };
      push(data.best_flights);
      push(data.other_flights);
      for (const o of out) all.push(o);
      if (all.length >= 15) break;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response) {
        const status = err.response.status;
        const body = JSON.stringify(err.response.data);
        throw new Error(`SerpAPI HTTP ${status}: ${body.slice(0, 600)}`);
      }
      // continue with next day
    }
  }
  return all;
}

export interface RoundTripSearchResult {
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
  route: GFlightsSegment[];
  id: string;
}

function isoDate(s: string): string {
  try {
    const d = new Date(s);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  } catch {}
  return s;
}

function firstAirlineCode(segs: GFlightsSegment[][]): string {
  if (!segs || segs.length === 0) return "?";
  if (segs[0].length === 0) return "?";
  return segs[0][0].airline_code || "?";
}

function segmentCollectAirline(segs: GFlightsSegment[][]): string[] {
  const set = new Set<string>();
  for (const leg of segs) {
    for (const s of leg) if (s.airline_code) set.add(s.airline_code);
  }
  return Array.from(set);
}

export async function searchRoundTripFlexible(
  apiKey: string,
  config: SearchConfig
): Promise<RoundTripSearchResult[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isLight = config.mode === "light";

  const fromCandidates: string[] = [];
  const toCandidates: string[] = [];
  const fromUpper = config.flyFrom.toUpperCase();
  const toUpper = config.flyTo.toUpperCase();
  const cityExpansions: Record<string, string[]> = {
    TYO: ["NRT", "HND"],
    SFO: ["SFO", "OAK", "SJC"],
    NYC: ["JFK", "LGA", "EWR"],
    LAX: ["LAX", "LGB", "BUR"],
    CHI: ["ORD", "MDW"],
    WAS: ["IAD", "DCA"],
    PAR: ["CDG", "ORY"],
    LON: ["LHR", "LGW", "STN"],
    SEL: ["ICN", "GMP"],
    SHA: ["PVG", "SHA"],
    SPK: ["CTS", "SPK"],
    OSA: ["KIX", "ITM"],
  };
  for (const c of cityExpansions[fromUpper] || []) {
    if (!fromCandidates.includes(c)) fromCandidates.push(c);
  }
  fromCandidates.push(fromUpper);
  for (const c of cityExpansions[toUpper] || []) {
    if (!toCandidates.includes(c)) toCandidates.push(c);
  }
  toCandidates.push(toUpper);

  const pool: RoundTripSearchResult[] = [];
  const seenKeys = new Set<string>();
  const maxPairs = isLight ? 5 : 8;
  const maxRoutes = isLight ? 2 : Math.min(fromCandidates.length * toCandidates.length, 4);
  const maxCalls = isLight ? 10 : 18;
  let apiCallCount = 0;

  const departDates: Date[] = [];
  const firstDepart = addDays(today, Math.max(10, Math.floor(config.searchDaysAhead / 5)));
  const lastDepart = addDays(today, Math.min(config.searchDaysAhead, Math.ceil(config.searchDaysAhead * 0.85)));
  const step = Math.max(4, Math.ceil((lastDepart.getTime() - firstDepart.getTime()) / (1000 * 60 * 60 * 24 * (maxPairs - 1 || 1))));
  for (let d = new Date(firstDepart), i = 0; i < maxPairs && d <= addDays(today, config.searchDaysAhead); d = addDays(d, step), i++) {
    departDates.push(new Date(d));
  }

  const midNights = Math.floor((config.minNights + config.maxNights) / 2);
  let routesTried = 0;
  outerRoute:
  for (const fCode of fromCandidates) {
    for (const tCode of toCandidates) {
      if (routesTried >= maxRoutes) break outerRoute;
      routesTried++;

      for (let dIdx = 0; dIdx < departDates.length; dIdx++) {
        if (apiCallCount >= maxCalls) break outerRoute;
        const depart = departDates[dIdx];
        const nightOffsets = new Set<number>([config.minNights, midNights, config.maxNights]);
        const nightsArr = Array.from(nightOffsets).filter(n => n >= config.minNights && n <= config.maxNights).slice(0, isLight ? 2 : 3);

        for (let nIdx = 0; nIdx < nightsArr.length; nIdx++) {
          if (apiCallCount >= maxCalls) break outerRoute;
          const nights = nightsArr[nIdx];
          const rtrn = addDays(depart, nights);

          let searchWithAirlines = config.selectAirlines.length > 0;
          for (let attempt = 0; attempt < 2; attempt++) {
            if (apiCallCount >= maxCalls) break outerRoute;
            try {
              apiCallCount++;
              const queryParams: Record<string, unknown> = {
                engine: "google_flights",
                api_key: apiKey,
                departure_id: fCode,
                arrival_id: tCode,
                outbound_date: format(depart, "yyyy-MM-dd"),
                return_date: format(rtrn, "yyyy-MM-dd"),
                currency: config.currency ?? "JPY",
                hl: "ja",
                adults: config.adults ?? 1,
                type: "1",
              };
              const aCodes = (searchWithAirlines && config.selectAirlines.length > 0) ? config.selectAirlines : undefined;
              if (aCodes && aCodes.length > 0) queryParams.airline_codes = aCodes.join(",");
              if (config.maxPriceJPY) queryParams.max_price = config.maxPriceJPY;

              const resp = await axios.get(SERPAPI_BASE + "/search", {
                params: queryParams,
                timeout: 15_000,
              });
              const data = resp.data as any;
              if (data?.error) {
                if (searchWithAirlines && attempt === 0) {
                  searchWithAirlines = false;
                  continue;
                }
                continue;
              }
              type Item = {
                flights?: unknown;
                price?: number;
                deep_link?: string;
                total_duration?: number;
                layovers?: number;
                departure_token?: string;
                booking_token?: string;
              };
              const pushList = (list: unknown) => {
                if (!Array.isArray(list)) return;
                for (const raw of list) {
                  const item = raw as Item;
                  if (!item || typeof item.price !== "number" || item.price <= 0) continue;
                  let flightsArr: GFlightsSegment[][] | null = null;
                  if (Array.isArray(item.flights)) {
                    flightsArr = item.flights as any;
                  }
                  let outSegs: GFlightsSegment[] = [];
                  let inSegs: GFlightsSegment[] = [];
                  if (flightsArr && flightsArr.length > 0) {
                    const maybeOut = flightsArr[0];
                    if (Array.isArray(maybeOut)) outSegs = maybeOut;
                    else if ((maybeOut as any) && Array.isArray((maybeOut as any).segments)) outSegs = (maybeOut as any).segments;
                    if (flightsArr.length > 1) {
                      const maybeIn = flightsArr[1];
                      if (Array.isArray(maybeIn)) inSegs = maybeIn;
                      else if ((maybeIn as any) && Array.isArray((maybeIn as any).segments)) inSegs = (maybeIn as any).segments;
                    }
                  }
                  if ((!outSegs || outSegs.length === 0) && Array.isArray(item.flights)) {
                    for (const top of item.flights as any[]) {
                      const segs = top?.segments || top;
                      if (Array.isArray(segs) && segs.length > 0 && segs[0]?.departure_airport) {
                        if (outSegs.length === 0) outSegs = segs;
                        else if (inSegs.length === 0) inSegs = segs;
                      }
                    }
                  }

                  const firstOut = outSegs[0];
                  const lastOut = outSegs.slice(-1)[0];
                  const firstIn = inSegs[0];
                  const lastIn = inSegs.slice(-1)[0];

                  const depStr = firstOut?.departure_airport?.time
                    || firstOut?.departure_airport?.departure_time
                    || "";
                  const arrStr = lastOut?.arrival_airport?.time
                    || lastOut?.arrival_airport?.arrival_time
                    || depStr;
                  const retDepStr = firstIn?.departure_airport?.time
                    || firstIn?.departure_airport?.departure_time
                    || "";
                  const retArrStr = lastIn?.arrival_airport?.time
                    || lastIn?.arrival_airport?.arrival_time
                    || retDepStr;

                  const depDate = depStr ? new Date(depStr) : (() => { const d = new Date(depart); d.setHours(10,0,0,0); return d; })();
                  const retDepDate = retDepStr ? new Date(retDepStr) : (() => { const d = new Date(rtrn); d.setHours(10,0,0,0); return d; })();
                  const actualNights = Number.isFinite(depDate.getTime()) && Number.isFinite(retDepDate.getTime())
                    ? Math.max(1, Math.round((retDepDate.getTime() - depDate.getTime()) / (1000 * 60 * 60 * 24)))
                    : nights;

                  const airlines = (flightsArr && flightsArr.length > 0)
                    ? segmentCollectAirline(flightsArr)
                    : (config.selectAirlines && config.selectAirlines.length > 0 ? config.selectAirlines : []);
                  const airlinesKey = airlines.length > 0 ? airlines.join(",") : "all";
                  const key = `${fCode}-${tCode}-${format(depDate, "yyyyMMdd")}-${actualNights}n-${airlinesKey}-${Math.floor(item.price / 1000)}`;
                  if (seenKeys.has(key)) continue;
                  seenKeys.add(key);
                  const flatRoute: GFlightsSegment[] = [];
                  for (const s of outSegs) flatRoute.push(s);
                  for (const s of inSegs) flatRoute.push(s);

                  pool.push({
                    price: item.price,
                    currency: "JPY",
                    flyFrom: fCode,
                    flyTo: tCode,
                    cityFrom: fCode,
                    cityTo: tCode,
                    local_departure: Number.isFinite(depDate.getTime()) ? depDate.toISOString() : depart.toISOString(),
                    local_arrival: arrStr ? isoDate(arrStr) : (() => { const d = new Date(depart); d.setHours(13,0,0,0); return d.toISOString(); })(),
                    return_departure: Number.isFinite(retDepDate.getTime()) ? retDepDate.toISOString() : rtrn.toISOString(),
                    return_arrival: retArrStr ? isoDate(retArrStr) : (() => { const d = new Date(rtrn); d.setHours(19,0,0,0); return d.toISOString(); })(),
                    airlines: airlines.length > 0 ? airlines : ["ALL"],
                    nightsInDest: actualNights,
                    deep_link: item.deep_link || `https://www.google.com/travel/flights?q=${fCode}-${tCode}-${format(depart, "yyyyMMdd")}-${format(rtrn, "yyyyMMdd")}`,
                    booking_token: item.booking_token || "",
                    route: flatRoute,
                    id: key,
                  });
                }
              };
              pushList(data.best_flights);
              pushList(data.other_flights);
              if (data.flights) {
                if (Array.isArray(data.flights)) pushList(data.flights);
                else pushList([data.flights]);
              }
              if (data?.trip_results?.flights) pushList(data.trip_results.flights);
              break;
            } catch (e) {
              if (searchWithAirlines && attempt === 0) {
                searchWithAirlines = false;
                continue;
              }
            }
          }
        }
      }
    }
  }

  pool.sort((a, b) => a.price - b.price);
  return pool;
}

export function getAirlineCodesFromFlight(
  f: RoundTripSearchResult
): string {
  return f.airlines.join(",");
}

export function getFirstLegDeparture(f: RoundTripSearchResult): string {
  return f.local_departure;
}

export function getReturnLegDeparture(f: RoundTripSearchResult): string {
  return f.return_departure;
}

export function getSearchBudgetHint() {
  return { searchBudget: 250 };
}
