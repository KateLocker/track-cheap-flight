import axios from "axios";
import { addDays } from "date-fns";
import type { SearchConfig } from "./config";
import { SearchBudget, dateText, sampleDepartureDates, sampleNights, matchesAirlines } from "./search-budget";

export interface GFlightsSegment {
  airline_code?: string;
  airline?: string | { code?: string };
  marketing_airline_code?: string;
  flight_number?: string;
  departure_airport?: { id?: string; name?: string; time?: string };
  arrival_airport?: { id?: string; name?: string; time?: string };
  duration?: number;
  stops?: unknown;
  technical_stops?: unknown;
  numberOfStops?: unknown;
}
export interface GFlightsOption {
  id?: string;
  price: number;
  airline_logo?: string;
  flights: GFlightsSegment[][];
  total_duration?: number;
  layovers?: unknown;
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
  nonStopOnly?: boolean;
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
  itineraryComplete?: boolean;
  isNonStop?: boolean;
}
export interface HardSearchResult extends RoundTripSearchResult { flights: unknown[]; raw?: unknown; }

export function expandCityToAirports(code: string): string[] {
  const upper = code.toUpperCase().trim();
  const cities: Record<string, string[]> = {
    TYO: ["NRT", "HND"], NYC: ["JFK", "LGA", "EWR"], CHI: ["ORD", "MDW"],
    WAS: ["IAD", "DCA"], PAR: ["CDG", "ORY"], LON: ["LHR", "LGW", "STN"],
    SEL: ["ICN", "GMP"], SHA: ["PVG", "SHA"], SPK: ["CTS"], OSA: ["KIX", "ITM"], BJS: ["PEK", "PKX"],
  };
  return cities[upper] ?? [upper];
}

function airline(seg: GFlightsSegment): string {
  const code = [seg.airline_code, typeof seg.airline === "object" ? seg.airline?.code : undefined, seg.marketing_airline_code]
    .find(s => typeof s === "string" && /^[A-Z0-9]{2}$/i.test(s.trim()));
  if (code) return code.trim().toUpperCase();
  const prefix = seg.flight_number?.trim().toUpperCase().match(/^([A-Z0-9]{2})\s*\d/)?.[1];
  return prefix || (typeof seg.airline === "string" && seg.airline.toUpperCase() !== "ALL" ? seg.airline : "?");
}
function legs(value: unknown): [GFlightsSegment[], GFlightsSegment[]] {
  if (!Array.isArray(value) || !value.length) return [[], []];
  const unpack = (v: unknown): GFlightsSegment[] => Array.isArray(v) ? v :
    v && typeof v === "object" && Array.isArray((v as { segments?: unknown }).segments)
      ? (v as { segments: GFlightsSegment[] }).segments : [];
  if (Array.isArray(value[0]) || Array.isArray(value[0]?.segments)) return [unpack(value[0]), unpack(value[1])];
  return [value as GFlightsSegment[], []];
}
type FlightItem = { price?: number; flights?: unknown; departure_token?: string; booking_token?: string; deep_link?: string; layovers?: unknown };
// SerpAPI's flights list enumerates the journey's segments; absent layovers means none.
// Reject contradictory or malformed stop metadata, even if the upstream filter was enabled.
function noListedStops(value: unknown): boolean {
  return value === undefined || value === 0 || (Array.isArray(value) && value.length === 0);
}
function singleNonStopLeg(segments: GFlightsSegment[]): boolean {
  const segment = segments[0];
  return segments.length === 1 && !!segment?.departure_airport?.id && !!segment.arrival_airport?.id
    && !!segment.departure_airport.time && !!segment.arrival_airport.time
    && segment.departure_airport.id !== segment.arrival_airport.id
    && [segment.stops, segment.technical_stops, segment.numberOfStops].every(noListedStops);
}
function items(data: Record<string, any>): FlightItem[] {
  return [data.best_flights, data.other_flights].flatMap(v => Array.isArray(v) ? v : []);
}
function usable(item: FlightItem, maxPrice?: number): boolean {
  return typeof item.price === "number" && Number.isFinite(item.price) && item.price > 0 && (maxPrice == null || item.price <= maxPrice);
}

export async function searchGoogleFlightsOneWay(params: SerpSearchParams): Promise<GFlightsOption[]> {
  const budget = new SearchBudget(10);
  const start = params.outbound_date_specific ?? params.outbound_date_start;
  const end = params.outbound_date_specific ?? params.outbound_date_end;
  const span = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
  const count = Math.min(10, span + 1);
  const results: GFlightsOption[] = [];
  for (let i = 0; i < count && budget.checkTime(); i++) {
    const depart = addDays(start, count === 1 ? 0 : Math.round(i * span / (count - 1)));
    try {
      const resp = await budget.request(options => axios.get("https://serpapi.com/search", { ...options, params: {
        engine: "google_flights", api_key: params.api_key, departure_id: params.departure_id, arrival_id: params.arrival_id,
        outbound_date: dateText(depart), return_date: params.return_date_specific ? dateText(params.return_date_specific) : undefined,
        type: params.return_date_specific ? "1" : "2", currency: params.currency ?? "JPY", hl: params.hl ?? "ja", adults: params.adults ?? 1,
        include_airlines: params.airlineCodes?.join(",") || undefined, max_price: params.maxPrice,
        stops: params.nonStopOnly ? 1 : undefined,
      } }));
      if (resp.data.error) throw new Error("SerpAPI search error");
      for (const item of items(resp.data)) if (usable(item, params.maxPrice)) results.push({ ...item, price: item.price!, flights: legs(item.flights) });
    } catch { budget.warn("未能完成部分日期的搜索。"); }
  }
  return results;
}

export async function searchRoundTripFlexible(apiKey: string, config: SearchConfig, budget?: SearchBudget): Promise<RoundTripSearchResult[]> {
  return searchSerpapiRoundTripHard({
    api_key: apiKey, fromAirports: expandCityToAirports(config.flyFrom), toAirports: expandCityToAirports(config.flyTo),
    searchDaysAhead: config.searchDaysAhead, minNights: config.minNights, maxNights: config.maxNights,
    adults: config.adults, airlineCodes: config.selectAirlines, maxPrice: config.maxPriceJPY ?? undefined, nonStopOnly: config.nonStopOnly,
    maxCalls: budget?.remainingRequests ?? (config.mode === "light" ? 10 : 16), budget,
  });
}
export function getAirlineCodesFromFlight(f: RoundTripSearchResult) { return f.airlines.join(","); }
export function getFirstLegDeparture(f: RoundTripSearchResult) { return f.local_departure; }
export function getReturnLegDeparture(f: RoundTripSearchResult) { return f.return_departure; }
export function getSearchBudgetHint() { return { searchBudget: 16, sampled: true }; }

export async function searchSerpapiRoundTripHard(params: {
  api_key: string; fromAirports: string[]; toAirports: string[]; searchDaysAhead: number; minNights: number; maxNights: number;
  maxCalls?: number; stopWhenFoundN?: number; stopWhenPriceBelow?: number; singleCallTimeoutMs?: number;
  airlineCodes?: string[]; maxPrice?: number; adults?: number; currency?: string; hl?: string;
  filterAirlines?: boolean; silent?: boolean; budget?: SearchBudget; nonStopOnly?: boolean;
}, onProgress?: (msg: string) => void): Promise<HardSearchResult[]> {
  const maxCalls = Math.max(1, Math.min(24, params.maxCalls ?? 16));
  const budget = params.budget ? params.budget.scope("SerpAPI", maxCalls, params.budget.remainingMs) : new SearchBudget(maxCalls);
  const currency = params.currency ?? "JPY";
  const selected = params.filterAirlines === false ? [] : (params.airlineCodes ?? []).map(s => s.toUpperCase());
  const dates = sampleDepartureDates(params.searchDaysAhead, Math.max(1, Math.floor(maxCalls / 2)));
  const nights = sampleNights(params.minNights, params.maxNights);
  const pool: HardSearchResult[] = [];
  const seen = new Set<string>();
  // Google supports comma-separated airports; one request searches the city's airports together.
  const origin = params.fromAirports.join(",");
  const destination = params.toAirports.join(",");
  const fetchItems = async (query: Record<string, unknown>) => {
    const response = await budget.request(options => axios.get("https://serpapi.com/search", { ...options, params: query }), params.singleCallTimeoutMs ?? 8_000);
    if (response.data?.error) { budget.warn("供应商未能完成搜索。"); return []; }
    return items(response.data).filter(item => usable(item, params.maxPrice)).sort((a, b) => a.price! - b.price!);
  };
  const store = (item: FlightItem, out: GFlightsSegment[], inbound: GFlightsSegment[], d1: string, d2: string, n: number, outboundItem?: FlightItem) => {
    if (!out.length) return;
    const route = [...out, ...inbound];
    const airlines = Array.from(new Set(route.map(airline)));
    const complete = !!(out[0]?.departure_airport?.time && inbound[0]?.departure_airport?.time);
    const isNonStop = complete && singleNonStopLeg(out) && singleNonStopLeg(inbound)
      && noListedStops(item.layovers) && noListedStops(outboundItem?.layovers)
      && params.fromAirports.includes(out[0].departure_airport!.id!) && params.toAirports.includes(out[0].arrival_airport!.id!)
      && params.toAirports.includes(inbound[0].departure_airport!.id!) && params.fromAirports.includes(inbound[0].arrival_airport!.id!)
      && (!Array.isArray(item.flights) || !(Array.isArray(item.flights[0]) || Array.isArray(item.flights[0]?.segments)) || item.flights.length === 2);
    if (params.nonStopOnly && !isNonStop) return;
    // A selected airline applies to every segment, including the return journey.
    if (selected.length && (!complete || !matchesAirlines(airlines, selected))) return;
    const from = out[0]?.departure_airport?.id ?? params.fromAirports[0];
    const to = out[out.length - 1]?.arrival_airport?.id ?? params.toAirports[0];
    const dep = out[0]?.departure_airport?.time || d1;
    const ret = inbound[0]?.departure_airport?.time || d2;
    const key = JSON.stringify([from, to, dep, ret, route.map(s => s.flight_number || airline(s)), item.price]);
    if (seen.has(key)) return;
    seen.add(key);
    pool.push({
      id: key, price: item.price!, currency, flyFrom: from, flyTo: to, cityFrom: from, cityTo: to,
      // Preserve airport-local times. A bare date explicitly means the provider omitted a time.
      local_departure: dep, local_arrival: out[out.length - 1]?.arrival_airport?.time || "",
      return_departure: ret, return_arrival: inbound[inbound.length - 1]?.arrival_airport?.time || "",
      airlines, nightsInDest: n, deep_link: item.deep_link || `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${from} to ${to} on ${d1} returning ${d2}`)}`,
      booking_token: item.booking_token || "", route, flights: [out, inbound], itineraryComplete: complete, isNonStop,
      raw: { itineraryComplete: complete, isNonStop, queriedDepartureDate: d1, queriedReturnDate: d2 },
    });
    if (!complete) budget.warn("部分报价未提供完整返程航段；日期为查询条件，时刻未确认。");
  };
  // Cover distinct departure dates first. Remaining calls try another stay length, never unbounded retries.
  for (let round = 0; round < nights.length && budget.checkTime(); round++) {
    for (let i = 0; i < dates.length && budget.checkTime(); i++) {
      const n = nights[(i + round) % nights.length];
      const d1 = dateText(dates[i]);
      const d2 = dateText(addDays(dates[i], n));
      const query: Record<string, unknown> = { engine: "google_flights", api_key: params.api_key, departure_id: origin, arrival_id: destination,
        outbound_date: d1, return_date: d2, type: "1", adults: params.adults ?? 1, currency, hl: params.hl ?? "ja", sort_by: "2",
        include_airlines: selected.join(",") || undefined, max_price: params.maxPrice, stops: params.nonStopOnly ? 1 : undefined };
      budget.recordDate(d1);
      try {
        const outboundOptions = await fetchItems(query);
        for (const item of outboundOptions) {
          const [out, inbound] = legs(item.flights);
          if (inbound.length) store(item, out, inbound, d1, d2, n);

        }
        // One cheapest eligible outbound is expanded per sampled date, within the same paid-call cap.
        const candidate = outboundOptions.find(item => {
          const [out, inbound] = legs(item.flights);
          return !inbound.length && item.departure_token && matchesAirlines(out.map(airline), selected)
            && (!params.nonStopOnly || (singleNonStopLeg(out) && noListedStops(item.layovers)));
        });
        const beforeExpansion = pool.length;
        if (candidate && budget.checkTime()) {
          const [out] = legs(candidate.flights);
          const returns = await fetchItems({ ...query, departure_token: candidate.departure_token });
          for (const item of returns) {
            const [ret] = legs(item.flights);
            store(item, out, ret, d1, d2, n, candidate);
          }
        }
        if (!params.nonStopOnly && pool.length === beforeExpansion) {
          const unconfirmed = outboundOptions.find(item => { const [out, inbound] = legs(item.flights); return !inbound.length && matchesAirlines(out.map(airline), selected); });
          if (unconfirmed) {
            if (!selected.length) store(unconfirmed, legs(unconfirmed.flights)[0], [], d1, d2, n);
            else budget.warn("返程航司尚未核验的报价已排除。");
          }
        }
        onProgress?.(`已搜索 ${d1} / ${n} 晚；收到 ${pool.length} 条报价。`);
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status === 401 || status === 403 || status === 429) return pool.sort((a, b) => a.price - b.price);
      }
    }
  }
  return pool.sort((a, b) => a.price - b.price);
}
