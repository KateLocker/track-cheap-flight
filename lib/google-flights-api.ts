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
  const maxDeparture = addDays(today, config.searchDaysAhead);
  const windows: Array<{ start: Date; end: Date }> = [];
  const totalDays = config.searchDaysAhead;
  const isLight = config.mode === "light";

  let cur = new Date(today);
  if (isLight) {
    const start = addDays(today, Math.min(14, Math.max(10, Math.floor(config.searchDaysAhead / 5))));
    const end = addDays(start, Math.min(21, Math.ceil(config.searchDaysAhead / 3)));
    windows.push({ start, end: end < maxDeparture ? end : new Date(maxDeparture) });
  } else {
    const stepDays = Math.min(14, Math.max(7, Math.ceil(totalDays / 5)));
    while (cur < maxDeparture && windows.length < 2) {
      const end = addDays(cur, stepDays);
      windows.push({
        start: new Date(cur),
        end: end < maxDeparture ? end : new Date(maxDeparture),
      });
      cur = addDays(cur, stepDays + 1);
    }
  }

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
  const maxOutboundsPerWindow = isLight ? 3 : 6;
  const maxReturnsPerOutbound = isLight ? 3 : 6;
  const maxFlightApiCalls = isLight ? 10 : 20;
  let apiCallCount = 0;

  for (let wIdx = 0; wIdx < windows.length; wIdx++) {
    const w = windows[wIdx];
    try {
      let outbounds: GFlightsOption[] = [];
      outer:
      for (const fCode of fromCandidates) {
        for (const tCode of toCandidates) {
          if (apiCallCount >= maxFlightApiCalls) break outer;
          if (outbounds.length >= 20) break outer;
          try {
            apiCallCount++;
            let outs = await searchGoogleFlightsOneWay({
              api_key: apiKey,
              departure_id: fCode,
              arrival_id: tCode,
              outbound_date_start: w.start,
              outbound_date_end: w.end,
              airlineCodes:
                config.selectAirlines.length > 0
                  ? config.selectAirlines
                  : undefined,
              maxPrice: config.maxPriceJPY ?? undefined,
              adults: config.adults,
              currency: "JPY",
              hl: "ja",
            });
            if (outs.length === 0 && config.selectAirlines.length > 0) {
              if (apiCallCount < maxFlightApiCalls) {
                apiCallCount++;
                outs = await searchGoogleFlightsOneWay({
                  api_key: apiKey,
                  departure_id: fCode,
                  arrival_id: tCode,
                  outbound_date_start: w.start,
                  outbound_date_end: w.end,
                  maxPrice: config.maxPriceJPY ?? undefined,
                  adults: config.adults,
                  currency: "JPY",
                  hl: "ja",
                });
              }
            }
            if (outs.length > 0) outbounds.push(...outs);
          } catch {
            /* ignore per city-pair error */
          }
        }
      }

      if (outbounds.length === 0) continue;

      const outCandidates = outbounds.slice(0, maxOutboundsPerWindow);
      for (let i = 0; i < outCandidates.length; i++) {
        if (apiCallCount >= maxFlightApiCalls) break;
        const out = outCandidates[i];
        const outFirstLeg = out.flights[0]?.[0];
        const outLastLegLastSeg =
          out.flights[out.flights.length - 1].slice(-1)[0];
        const outboundDepartStr = outFirstLeg?.departure_airport?.time;
        const outboundArriveStr = outLastLegLastSeg?.arrival_airport?.time;
        if (!outboundDepartStr) continue;

        const outDepartDate = new Date(outboundDepartStr);
        if (!Number.isFinite(outDepartDate.getTime())) continue;

        const returnStart = addDays(outDepartDate, config.minNights);
        const returnEnd = addDays(outDepartDate, config.maxNights);
        const windowEnd = addDays(w.end, config.maxNights);
        if (returnStart > windowEnd) continue;
        const returnWindowEnd =
          returnEnd < windowEnd ? returnEnd : windowEnd;

        let returns: GFlightsOption[] = [];
        outerRet:
        for (const rFrom of toCandidates) {
          for (const rTo of fromCandidates) {
            if (apiCallCount >= maxFlightApiCalls) break outerRet;
            if (returns.length >= 20) break outerRet;
            try {
              apiCallCount++;
              let r = await searchGoogleFlightsOneWay({
                api_key: apiKey,
                departure_id: rFrom,
                arrival_id: rTo,
                outbound_date_start: returnStart,
                outbound_date_end: returnWindowEnd,
                airlineCodes:
                  config.selectAirlines.length > 0
                    ? config.selectAirlines
                    : undefined,
                maxPrice: config.maxPriceJPY
                  ? config.maxPriceJPY - out.price
                  : undefined,
                adults: config.adults,
                currency: "JPY",
                hl: "ja",
              });
              if (r.length === 0 && config.selectAirlines.length > 0 && apiCallCount < maxFlightApiCalls) {
                apiCallCount++;
                r = await searchGoogleFlightsOneWay({
                  api_key: apiKey,
                  departure_id: rFrom,
                  arrival_id: rTo,
                  outbound_date_start: returnStart,
                  outbound_date_end: returnWindowEnd,
                  maxPrice: config.maxPriceJPY
                    ? config.maxPriceJPY - out.price
                    : undefined,
                  adults: config.adults,
                  currency: "JPY",
                  hl: "ja",
                });
              }
              if (r.length > 0) returns.push(...r);
            } catch {
              /* ignore */
            }
          }
        }

        for (let j = 0; j < Math.min(returns.length, maxReturnsPerOutbound); j++) {
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
          if (nights < config.minNights || nights > config.maxNights)
            continue;

          const totalPrice = out.price + ret.price;
          if (
            config.maxPriceJPY != null &&
            totalPrice > config.maxPriceJPY
          )
            continue;

          const outAirline = firstAirlineCode(out.flights);
          const retAirline = firstAirlineCode(ret.flights);
          if (config.selectAirlines.length > 0) {
            const outOK = config.selectAirlines.some(
              (code) => outAirline === code
            );
            const retOK = config.selectAirlines.some(
              (code) => retAirline === code
            );
            const outSegs = segmentCollectAirline(out.flights);
            const retSegs = segmentCollectAirline(ret.flights);
            const outSegsOK = outSegs.some((s) =>
              config.selectAirlines.includes(s)
            );
            const retSegsOK = retSegs.some((s) =>
              config.selectAirlines.includes(s)
            );
            const bothOK =
              (outOK || outSegsOK) && (retOK || retSegsOK);
            if (!bothOK) {
              // if not matching but low price, still keep up to 30% of such options
              const priceOK =
                !config.maxPriceJPY ||
                totalPrice <= config.maxPriceJPY * 1.15;
              if (!priceOK) continue;
            }
          }

          const key = `${format(
            outDepartDate,
            "yyyyMMdd"
          )}|${format(retDepartDate, "yyyyMMdd")}|${outAirline}|${
            retAirline
          }|${Math.floor(totalPrice / 1000)}`;
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
            local_arrival: isoDate(
              outboundArriveStr ?? outboundDepartStr
            ),
            return_departure: isoDate(retDepartStr),
            return_arrival: isoDate(retArriveStr ?? retDepartStr),
            airlines: Array.from(airlinesSet),
            nightsInDest: nights,
            deep_link: out.deep_link ?? ret.deep_link ?? "",
            booking_token: `${out.departure_token ?? ""}|${
              ret.departure_token ?? ""
            }`,
            route,
          });
        }
      }
    } catch {
      /* skip single window */
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
