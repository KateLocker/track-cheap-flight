import axios from "axios";
import { format, addDays, addMonths } from "date-fns";
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
  minNights: number;
  maxNights: number;
  airlineCodes?: string[];
  maxPrice?: number;
  adults?: number;
  currency?: string;
  hl?: string;
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
  const queryParams: Record<string, unknown> = {
    engine: "google_flights",
    api_key: params.api_key,
    departure_id: params.departure_id,
    arrival_id: params.arrival_id,
    outbound_date: dateRangeToStr(params.outbound_date_start, params.outbound_date_end),
    currency: params.currency ?? "JPY",
    hl: params.hl ?? "ja",
    adults: params.adults ?? 1,
    stops: 1,
    travel_class: 1,
  };

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
      best_flights?: Array<{ flights: GFlightsSegment[][]; price: number; type?: string; deep_link?: string; total_duration?: number; layovers?: number }>;
      other_flights?: Array<{ flights: GFlightsSegment[][]; price: number; deep_link?: string; total_duration?: number; layovers?: number }>;
    };

    const out: GFlightsOption[] = [];
    const push = (list: typeof data.best_flights) => {
      if (!list) return;
      for (const item of list) {
        out.push({
          price: item.price,
          flights: item.flights,
          deep_link: item.deep_link,
          total_duration: item.total_duration,
          layovers: item.layovers,
        });
      }
    };
    push(data.best_flights);
    push(data.other_flights);
    return out;
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      const status = err.response.status;
      const body = JSON.stringify(err.response.data);
      throw new Error(
        `SerpAPI HTTP ${status}: ${body.slice(0, 600)}`
      );
    }
    throw err;
  }
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
  const maxDeparture = addDays(today, config.searchDaysAhead);
  const windows: Array<{ start: Date; end: Date }> = [];
  const totalDays = config.searchDaysAhead;
  let cur = new Date(today);
  const stepDays = Math.min(21, Math.max(7, Math.ceil(totalDays / 6)));
  while (cur < maxDeparture) {
    const end = addDays(cur, stepDays);
    windows.push({
      start: new Date(cur),
      end: end < maxDeparture ? end : new Date(maxDeparture),
    });
    cur = addDays(cur, stepDays + 1);
  }

  const pool: RoundTripSearchResult[] = [];
  const seenKeys = new Set<string>();

  for (const w of windows) {
    try {
      const windowEnd = addDays(w.end, config.maxNights);
      const outbounds = await searchGoogleFlightsOneWay({
        api_key: apiKey,
        departure_id: config.flyFrom,
        arrival_id: config.flyTo,
        outbound_date_start: w.start,
        outbound_date_end: w.end,
        airlineCodes: config.selectAirlines,
        maxPrice: config.maxPriceJPY ?? undefined,
        adults: config.adults,
        currency: "JPY",
        hl: "ja",
        minNights: config.minNights,
        maxNights: config.maxNights,
      });

      if (outbounds.length === 0) continue;

      for (let i = 0; i < Math.min(outbounds.length, 12); i++) {
        const out = outbounds[i];
        const outFirstLeg = out.flights[0]?.[0];
        const outLastLegLastSeg = out.flights[out.flights.length - 1].slice(-1)[0];
        const outboundDepartStr = outFirstLeg?.departure_airport?.time;
        const outboundArriveStr = outLastLegLastSeg?.arrival_airport?.time;
        if (!outboundDepartStr || !outboundArriveStr) continue;

        const outDepartDate = new Date(outboundDepartStr);
        const outArriveDate = new Date(outboundArriveStr);
        if (!Number.isFinite(outDepartDate.getTime())) continue;

        const returnStart = addDays(outDepartDate, config.minNights);
        const returnEnd = addDays(outDepartDate, config.maxNights);
        if (returnStart > windowEnd) continue;
        const returnWindowEnd = returnEnd < windowEnd ? returnEnd : windowEnd;

        try {
          const returns = await searchGoogleFlightsOneWay({
            api_key: apiKey,
            departure_id: config.flyTo,
            arrival_id: config.flyFrom,
            outbound_date_start: returnStart,
            outbound_date_end: returnWindowEnd,
            airlineCodes: config.selectAirlines,
            maxPrice: config.maxPriceJPY
              ? config.maxPriceJPY - out.price
              : undefined,
            adults: config.adults,
            currency: "JPY",
            hl: "ja",
            minNights: 0,
            maxNights: 0,
          });

          for (let j = 0; j < Math.min(returns.length, 10); j++) {
            const ret = returns[j];
            const retFirstLeg = ret.flights[0]?.[0];
            const retLastLegLastSeg =
              ret.flights[ret.flights.length - 1].slice(-1)[0];
            const retDepartStr = retFirstLeg?.departure_airport?.time;
            const retArriveStr = retLastLegLastSeg?.arrival_airport?.time;
            if (!retDepartStr) continue;
            const retDepartDate = new Date(retDepartStr);
            if (!Number.isFinite(retDepartDate.getTime())) continue;

            const nightsMs =
              retDepartDate.getTime() - outDepartDate.getTime();
            const nights = Math.max(
              0,
              Math.round(nightsMs / (1000 * 60 * 60 * 24))
            );
            if (nights < config.minNights || nights > config.maxNights) continue;

            const totalPrice = out.price + ret.price;
            if (
              config.maxPriceJPY != null &&
              totalPrice > config.maxPriceJPY
            )
              continue;

            const outAirline = firstAirlineCode(out.flights);
            const retAirline = firstAirlineCode(ret.flights);
            if (
              config.selectAirlines.length > 0 &&
              !(
                config.selectAirlines.includes(outAirline) &&
                config.selectAirlines.includes(retAirline)
              )
            )
              continue;

            const key = `${format(
              outDepartDate,
              "yyyyMMdd"
            )}|${format(retDepartDate, "yyyyMMdd")}|${outAirline}|${Math.floor(
              totalPrice / 1000
            )}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);

            const airlinesSet = new Set<string>();
            const route: GFlightsSegment[] = [];
            for (const leg of out.flights) {
              for (const s of leg) {
                if (s.airline_code) airlinesSet.add(s.airline_code);
                route.push(s);
              }
            }
            for (const leg of ret.flights) {
              for (const s of leg) {
                if (s.airline_code) airlinesSet.add(s.airline_code);
                route.push(s);
              }
            }

            pool.push({
              id: key,
              price: totalPrice,
              currency: "JPY",
              flyFrom: config.flyFrom,
              flyTo: config.flyTo,
              cityFrom: config.flyFrom,
              cityTo: config.flyTo,
              local_departure: isoDate(outboundDepartStr),
              local_arrival: isoDate(outboundArriveStr),
              return_departure: isoDate(retDepartStr),
              return_arrival: isoDate(retArriveStr ?? retDepartStr),
              airlines: Array.from(airlinesSet),
              nightsInDest: nights,
              deep_link:
                out.deep_link && ret.deep_link
                  ? out.deep_link
                  : "",
              booking_token:
                (out.departure_token || "") +
                "|" +
                (ret.departure_token || ""),
              route,
            });
          }
        } catch {
          /* ignore single return search error */
        }
      }
    } catch {
      /* skip single window */
    }
  }

  pool.sort((a, b) => a.price - b.price);
  return pool;
}

export function getAirlineCodesFromFlight(f: RoundTripSearchResult): string {
  return f.airlines.join(",");
}

export function getFirstLegDeparture(f: RoundTripSearchResult): string {
  return f.local_departure;
}

export function getReturnLegDeparture(f: RoundTripSearchResult): string {
  return f.return_departure;
}

const MONTHLY = { searchBudget: 250 };

export function getSearchBudgetHint() {
  return MONTHLY;
}
