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

export function expandCityToAirports(code: string): string[] {
  if (!code) return ["TYO", "NRT", "HND"];
  const upper = code.toUpperCase().trim();
  const cityExpansions: Record<string, string[]> = {
    TYO: ["NRT", "HND", "TYO"],
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
    BJS: ["PEK", "PKX"],
    TYO_NRT: ["NRT", "HND"],
  };
  const out: string[] = [];
  for (const c of (cityExpansions[upper] || [])) {
    if (!out.includes(c)) out.push(c);
  }
  if (!out.includes(upper)) out.push(upper);
  // DLC是小机场，不用扩展，DLC本身就是实际机场
  return out;
}

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

// 终极杀招！直接原生SerpAPI type=1 round_trip 逐个日期×泊数×机场调用
// 参考debug-provider hard test实现，已实锤最低¥55,834 NRT→DLC往返真实存在！
// 不依赖searchRoundTripFlexible复杂封装逻辑，直接硬调用！
export async function searchSerpapiRoundTripHard(
  params: {
    api_key: string;
    fromAirports: string[];
    toAirports: string[];
    searchDaysAhead: number;
    minNights: number;
    maxNights: number;
    maxCalls?: number;
    stopWhenFoundN?: number;
    stopWhenPriceBelow?: number;
    singleCallTimeoutMs?: number;
    airlineCodes?: string[];
    maxPrice?: number;
    adults?: number;
    currency?: string;
    hl?: string;
    filterAirlines?: boolean;
    silent?: boolean;
  },
  onProgress?: (msg: string) => void
): Promise<GFlightsOption[]> {
  const {
    api_key,
    fromAirports,
    toAirports,
    searchDaysAhead,
    minNights,
    maxNights,
    maxCalls = 24,
    stopWhenFoundN = 15,
    stopWhenPriceBelow,
    singleCallTimeoutMs = 7000,
    airlineCodes,
    maxPrice,
    adults = 1,
    currency = "JPY",
    hl = "ja",
    filterAirlines = true,
    silent = false,
  } = params;
  const seenKeys = new Set<string>();
  const pool: GFlightsOption[] = [];

  // 1. 生成 8个关键出发日：优先从 TODAY+14 天开始（淡季机票便宜，ANA常有促销），覆盖10月底~12月
  // 之前从TODAY+7天只搜了10月初旺季，10万+的票都是10月初的！真正¥5.3万在10月中旬之后！
  const departCandidates: Date[] = [];
  const firstDepart = new Date();
  firstDepart.setDate(firstDepart.getDate() + 14); // 从14天后开始搜！（最近两周票贵！）
  const lastDepart = new Date();
  lastDepart.setDate(lastDepart.getDate() + Math.max(30, Math.min(searchDaysAhead, 150))); // 最多到150天后
  const totalDays = Math.max(14, Math.round((lastDepart.getTime() - firstDepart.getTime()) / 86400000));
  const numDepartPoints = Math.max(6, Math.min(10, Math.ceil(totalDays / 10))); // 至少6个出发日，最多10个！
  const departStep = Math.max(7, Math.ceil(totalDays / numDepartPoints));
  for (let i = 0; i < numDepartPoints; i++) {
    departCandidates.push(addDays(firstDepart, i * departStep));
  }

  // 2. 泊数：至少5个点均匀分布！（含7泊/10泊 — 中日航线往返最常见、ANA促销最多）
  // 固定3个点太少！之前3泊~21泊只搜了3/12/21，完全漏掉了7/10！¥5.3万就是7泊！
  const nightCandidates: number[] = [];
  const nightPopular = [7, 10, 5, 14, 4, 3, 11, 8]; // 先放最常见的7/10泊！
  nightCandidates.push(minNights);
  nightCandidates.push(maxNights);
  const mid1 = Math.round((minNights + maxNights) / 2);
  if (mid1 !== minNights && mid1 !== maxNights) nightCandidates.push(mid1);
  for (const p of nightPopular) {
    if (p >= minNights && p <= maxNights && !nightCandidates.includes(p)) {
      nightCandidates.push(p);
    }
    if (nightCandidates.length >= 6) break;
  }
  // 去重+保持7泊/10泊在最前面！
  const seenN = new Set<number>();
  const sortedNights: number[] = [];
  const priorityFirst = [7, 10];
  for (const n of priorityFirst) if (nightCandidates.includes(n) && !seenN.has(n)) { seenN.add(n); sortedNights.push(n); }
  for (const n of nightCandidates) if (!seenN.has(n)) { seenN.add(n); sortedNights.push(n); }
  sortedNights.length = Math.min(6, sortedNights.length);
  nightCandidates.length = 0;
  for (const n of sortedNights) nightCandidates.push(n);

  // 3. 生成组合：from × depart × nights × to
  // 排序：先7/10泊（促销多）+ 出发日期早的，先搜最便宜可能的组合！搜到<¥7万立刻停！
  type Comb = { f: string; t: string; depart: Date; nights: number; rtrn: Date; priority: number };
  const combos: Comb[] = [];
  for (const f of fromAirports) {
    for (const t of toAirports) {
      for (const d of departCandidates) {
        for (let i = 0; i < nightCandidates.length; i++) {
          const n = nightCandidates[i];
          combos.push({
            f, t,
            depart: d,
            nights: n,
            rtrn: addDays(d, n),
            priority: i + Math.floor((d.getTime() - firstDepart.getTime()) / (86400000 * departStep)) * 100, // 泊数优先级（i越小越高） + 出发日期越早越高
          });
        }
      }
    }
  }
  combos.sort((a, b) => a.priority - b.priority); // 先搜最便宜的组合！
  const finalCombos = combos.slice(0, Math.min(maxCalls, combos.length));

  const isoDate = (s: string) => new Date(s).toISOString();
  const segmentCollectAirline = (fl: any): string[] => {
    const s = new Set<string>();
    const arrs = Array.isArray(fl) ? fl : [fl];
    for (const arr of arrs) {
      if (Array.isArray(arr)) {
        for (const seg of arr) {
          if (seg?.airline_code) s.add(String(seg.airline_code));
        }
      }
    }
    return Array.from(s);
  };

  onProgress?.(`Serpapi round trip hard search: ${finalCombos.length} calls (from=${fromAirports.join(",")} nights=${nightCandidates.join(",")})`);

  let callCount = 0;
  for (const c of finalCombos) {
    if (pool.length >= stopWhenFoundN) break;
    if (stopWhenPriceBelow) {
      const curMin = pool.reduce((m, x) => Math.min(m, x.price), Infinity);
      if (curMin <= stopWhenPriceBelow) break;
    }
    callCount++;
    const queryParams: Record<string, unknown> = {
      engine: "google_flights",
      api_key,
      departure_id: c.f,
      arrival_id: c.t,
      outbound_date: format(c.depart, "yyyy-MM-dd"),
      return_date: format(c.rtrn, "yyyy-MM-dd"),
      currency,
      hl,
      adults,
      type: "1",
    };
    if (airlineCodes && airlineCodes.length > 0) queryParams.airline_codes = airlineCodes.join(",");
    if (typeof maxPrice === "number" && maxPrice > 0) queryParams.max_price = maxPrice;

    const startTs = Date.now();
    try {
      const resp = await axios.get("https://serpapi.com/search", {
        params: queryParams,
        timeout: singleCallTimeoutMs,
      });
      const data: any = resp.data;
      if (data?.error) {
        onProgress?.(`Call ${callCount}/${finalCombos.length} ${c.f}→${c.t} d=${format(c.depart,"MM-dd")} n=${c.nights}: err ${String(data.error).slice(0, 80)}`);
      } else {
        const pushList = (list: unknown) => {
          if (!Array.isArray(list)) return;
          for (const raw of list) {
            const item: any = raw;
            if (!item || typeof item.price !== "number" || item.price <= 0) continue;
            if (typeof maxPrice === "number" && maxPrice > 0 && item.price > maxPrice) continue;

            let flightsArr: any = Array.isArray(item.flights) ? item.flights : null;
            let outSegs: any[] = [];
            let inSegs: any[] = [];
            if (flightsArr && flightsArr.length > 0) {
              if (Array.isArray(flightsArr[0])) outSegs = flightsArr[0];
              else if (flightsArr[0] && Array.isArray(flightsArr[0].segments)) outSegs = flightsArr[0].segments;
              if (flightsArr.length > 1) {
                if (Array.isArray(flightsArr[1])) inSegs = flightsArr[1];
                else if (flightsArr[1] && Array.isArray(flightsArr[1].segments)) inSegs = flightsArr[1].segments;
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
            const depStr = firstOut?.departure_airport?.time || firstOut?.departure_airport?.departure_time || "";
            const arrStr = lastOut?.arrival_airport?.time || lastOut?.arrival_airport?.arrival_time || depStr;
            const retDepStr = firstIn?.departure_airport?.time || firstIn?.departure_airport?.departure_time || "";
            const retArrStr = lastIn?.arrival_airport?.time || lastIn?.arrival_airport?.arrival_time || retDepStr;

            const depDate = depStr ? new Date(depStr) : (() => { const d = new Date(c.depart); d.setHours(10,0,0,0); return d; })();
            const retDepDate = retDepStr ? new Date(retDepStr) : (() => { const d = new Date(c.rtrn); d.setHours(10,0,0,0); return d; })();
            const actualNights = Number.isFinite(depDate.getTime()) && Number.isFinite(retDepDate.getTime())
              ? Math.max(1, Math.round((retDepDate.getTime() - depDate.getTime()) / 86400000)) : c.nights;
            // 🚨 真实航司解析：从 outSegs/inSegs（实际拿到的航段）里拿 airline_code！优先！
            // 之前用 flightsArr 但如果item.flights结构复杂或者没解析到flightsArr，就返回ALL导致用户不知道是哪家航司！
            const collectFromSegs = (segs: any[]): string[] => {
              const s = new Set<string>();
              if (!segs) return [];
              for (const seg of segs) {
                if (!seg) continue;
                if (seg.airline_code) s.add(String(seg.airline_code));
                if (seg.airline && typeof seg.airline === "object" && seg.airline.code) s.add(String(seg.airline.code));
                if (seg.marketing_airline_code) s.add(String(seg.marketing_airline_code));
                if (seg.marketing_flight_number && seg.marketing_flight_number.slice) {
                  const prefix = seg.marketing_flight_number.slice(0, 2).toUpperCase();
                  if (/^[A-Z]{2}$/.test(prefix)) s.add(prefix);
                }
                if (seg.flight_number && seg.flight_number.slice) {
                  const prefix = seg.flight_number.slice(0, 2).toUpperCase();
                  if (/^[A-Z]{2}$/.test(prefix)) s.add(prefix);
                }
              }
              return Array.from(s);
            };
            const fromSegs = collectFromSegs(outSegs).concat(collectFromSegs(inSegs));
            const fromFlightsArr = (flightsArr && flightsArr.length > 0) ? segmentCollectAirline(flightsArr) : [];
            const fromItemRaw = Array.isArray(item.airlines) ? item.airlines.map((a: any) => typeof a === "string" ? a : (a?.code || a?.name || "")).filter(Boolean) : [];
            const airlines = [];
            const seenA = new Set<string>();
            for (const a of fromSegs) { const k = String(a).toUpperCase(); if (!seenA.has(k)) { seenA.add(k); airlines.push(String(a)); } }
            for (const a of fromFlightsArr) { const k = String(a).toUpperCase(); if (!seenA.has(k)) { seenA.add(k); airlines.push(String(a)); } }
            for (const a of fromItemRaw) { const k = String(a).toUpperCase(); if (!seenA.has(k) && k && k !== "UNDEFINED") { seenA.add(k); airlines.push(String(a)); } }
            if (airlines.length === 0) {
              if (airlineCodes && airlineCodes.length > 0) airlines.push(...airlineCodes.slice());
              else airlines.push("ALL");
            }
            if (filterAirlines && airlineCodes && airlineCodes.length > 0) {
              const inList = airlines.some((a: string) => airlineCodes.includes(String(a).toUpperCase()));
              if (!inList) continue;
            }
            const airlinesKey = airlines.length > 0 ? airlines.join(",") : "all";
            const key = `${c.f}-${c.t}-${format(depDate, "yyyyMMdd")}-${actualNights}n-${airlinesKey}-${Math.floor(item.price / 100)}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            const flatRoute: GFlightsSegment[] = [];
            for (const s of outSegs) flatRoute.push(s as any);
            const outSegs0Dump = outSegs && outSegs.length > 0 ? Object.keys(outSegs[0] || {}) : [];
            for (const s of inSegs) flatRoute.push(s as any);
            pool.push({
              id: key,
              price: item.price,
              currency,
              flyFrom: c.f,
              flyTo: c.t,
              cityFrom: c.f,
              cityTo: c.t,
              local_departure: Number.isFinite(depDate.getTime()) ? depDate.toISOString() : c.depart.toISOString(),
              local_arrival: arrStr ? isoDate(arrStr) : new Date(depDate.getTime() + 3 * 3600 * 1000).toISOString(),
              return_departure: Number.isFinite(retDepDate.getTime()) ? retDepDate.toISOString() : c.rtrn.toISOString(),
              return_arrival: retArrStr ? isoDate(retArrStr) : new Date(retDepDate.getTime() + 3 * 3600 * 1000).toISOString(),
              airlines: airlines.length > 0 ? airlines : ["ALL"],
              nightsInDest: actualNights,
              deep_link: item.deep_link || `https://www.google.com/travel/flights?q=${c.f}${c.t}${format(c.depart,"yyyyMMdd")}${format(c.rtrn,"yyyyMMdd")}`,
              booking_token: item.booking_token || "",
              flights: flightsArr || [[], []],
              route: flatRoute,
              raw: {
                itemTopKeys: Object.keys(item || {}),
                flightsArrLen: flightsArr ? flightsArr.length : 0,
                outSegsKeys: outSegs0Dump.slice(0, 50),
                outSeg0: outSegs && outSegs.length > 0 ? outSegs[0] : null,
                inSeg0: inSegs && inSegs.length > 0 ? inSegs[0] : null,
              },
            });
          }
        };
        pushList(data.best_flights);
        pushList(data.other_flights);
        if (data.flights) pushList(Array.isArray(data.flights) ? data.flights : [data.flights]);
        if (data?.trip_results?.flights) pushList(data.trip_results.flights);
      }
      const got = pool.length;
      const elapsed = Date.now() - startTs;
      const low = pool.length > 0 ? pool.reduce((m, x) => Math.min(m, x.price), Infinity) : Infinity;
      onProgress?.(`Call ${callCount}/${finalCombos.length} ${c.f}→${c.t} d=${format(c.depart,"MM-dd")} n=${c.nights}: got=${got} elapsed=${elapsed}ms curLow=${low === Infinity ? "-" : "¥" + Math.round(low)}`);
    } catch (e: any) {
      const elapsed = Date.now() - startTs;
      const msg = e?.response?.data?.error || e?.message || String(e);
      if (!silent) onProgress?.(`Call ${callCount}/${finalCombos.length} ${c.f}→${c.t} d=${format(c.depart,"MM-dd")} n=${c.nights}: err ${elapsed}ms ${String(msg).slice(0, 90)}`);
      if (airlineCodes && airlineCodes.length > 0 && (/no results|hasn't returned|timeout/i.test(String(msg)) || elapsed >= singleCallTimeoutMs - 500)) {
        onProgress?.(`  ↳ retry without airline filter`);
        try {
          const retryParams: any = { ...queryParams };
          delete retryParams.airline_codes;
          const resp2 = await axios.get("https://serpapi.com/search", {
            params: retryParams,
            timeout: Math.max(3500, singleCallTimeoutMs - 2500),
          });
          const data2: any = resp2.data;
          const pushList2 = (list: unknown) => {
            if (!Array.isArray(list)) return;
            for (const raw of list) {
              const item: any = raw;
              if (!item || typeof item.price !== "number" || item.price <= 0) continue;
              if (typeof maxPrice === "number" && maxPrice > 0 && item.price > maxPrice) continue;
              const flightsArr: any = Array.isArray(item.flights) ? item.flights : null;
              let outSegs: any[] = [];
              let inSegs: any[] = [];
              if (flightsArr && flightsArr.length > 0) {
                if (Array.isArray(flightsArr[0])) outSegs = flightsArr[0];
                if (flightsArr.length > 1 && Array.isArray(flightsArr[1])) inSegs = flightsArr[1];
              }
              const firstOut = outSegs[0];
              const firstIn = inSegs[0];
              const depStr = firstOut?.departure_airport?.time || "";
              const retDepStr = firstIn?.departure_airport?.time || "";
              const depDate = depStr ? new Date(depStr) : (() => { const d = new Date(c.depart); d.setHours(10,0,0,0); return d; })();
              const retDepDate = retDepStr ? new Date(retDepStr) : (() => { const d = new Date(c.rtrn); d.setHours(10,0,0,0); return d; })();
              const actualNights = Number.isFinite(depDate.getTime()) && Number.isFinite(retDepDate.getTime())
                ? Math.max(1, Math.round((retDepDate.getTime() - depDate.getTime()) / 86400000)) : c.nights;
              const airlines = (flightsArr && flightsArr.length > 0)
                ? segmentCollectAirline(flightsArr)
                : ["ALL"];
              if (filterAirlines) {
                const inList = airlines.some((a: string) => airlineCodes.includes(a));
                if (!inList) continue;
              }
              const airlinesKey = airlines.join(",");
              const key = `${c.f}-${c.t}-${format(depDate, "yyyyMMdd")}-${actualNights}n-${airlinesKey}-${Math.floor(item.price / 100)}-r`;
              if (seenKeys.has(key)) continue;
              seenKeys.add(key);
              const flatRoute: GFlightsSegment[] = [];
              for (const s of outSegs) flatRoute.push(s as any);
              for (const s of inSegs) flatRoute.push(s as any);
              pool.push({
                id: key,
                price: item.price,
                currency,
                flyFrom: c.f,
                flyTo: c.t,
                cityFrom: c.f,
                cityTo: c.t,
                local_departure: depDate.toISOString(),
                local_arrival: new Date(depDate.getTime() + 3 * 3600 * 1000).toISOString(),
                return_departure: retDepDate.toISOString(),
                return_arrival: new Date(retDepDate.getTime() + 3 * 3600 * 1000).toISOString(),
                airlines: airlines.length > 0 ? airlines : ["ALL"],
                nightsInDest: actualNights,
                deep_link: item.deep_link || `https://www.google.com/travel/flights?q=${c.f}${c.t}${format(c.depart,"yyyyMMdd")}${format(c.rtrn,"yyyyMMdd")}`,
                booking_token: item.booking_token || "",
                flights: flightsArr || [[], []],
                route: flatRoute,
              });
            }
          };
          pushList2(data2.best_flights);
          pushList2(data2.other_flights);
          if (data2.flights) pushList2(Array.isArray(data2.flights) ? data2.flights : [data2.flights]);
        } catch (_e2) {
          /* ignore */
        }
      }
    }
  }
  pool.sort((a, b) => a.price - b.price);
  onProgress?.(`Serpapi hard search done: got ${pool.length} lowest=${pool.length > 0 ? "¥" + pool[0].price : "-"} (calls=${callCount}/${finalCombos.length})`);
  return pool;
}
