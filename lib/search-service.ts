import { loadConfig, AppConfig, SearchConfig } from "./config";
import { searchRoundTripFlexible as kiwiSearch, KiwiFlight, getAirlineCodesFromFlight as kiwiAirlines, getFirstLegDeparture as kiwiFirstDep, getReturnLegDeparture as kiwiReturnDep } from "./kiwi-api";
import { searchRoundTripFlexible as serpSearch, RoundTripSearchResult } from "./google-flights-api";
import { searchRoundTripFlexible as amadeusSearch, AmadeusRoundTrip } from "./amadeus-api";
import { searchRoundTripFlexible as skySearch, SkyscannerRoundTrip } from "./skyscanner-api";
import { getDb, persistSearchRun, upsertLowestPrice, insertNotificationLog, claimNotification, releaseNotificationClaim, hasFailedNotification, FlightRecord } from "./db";
import { sendAlertEmail, safeBookingLink } from "./email";
import { SearchBudget, matchesAirlines } from "./search-budget";

const AIRLINE_NAMES: Record<string, string> = {
  NH: "全日空 (ANA)", JL: "日本航空 (JAL)", CA: "中国国航", CZ: "南方航空", MU: "東方航空", HU: "海南航空",
  "9C": "春秋航空", ZH: "深圳航空", MF: "厦門航空", OZ: "アシアナ航空 (韩亚航空)", KE: "大韓航空", FM: "上海航空",
};
export function getAirlineName(code: string): string {
  return code.split(",").map(c => c.trim()).map(c => !c || c === "ALL" || c === "?" ? "航空会社未確認" : AIRLINE_NAMES[c] || c).join(" / ");
}
type Provider = "kiwi" | "serpapi" | "amadeus" | "skyscanner";
export interface UnifiedFlight {
  id: string; priceJPY: number; currency: string; flyFrom: string; flyTo: string; cityFrom: string; cityTo: string;
  airlineCode: string; departureAt: string; returnAt: string; nightsInDest: number; deep_link: string; booking_token: string;
  raw: unknown; source: Provider; itineraryComplete: boolean; isNonStop?: boolean;
}
function unifyKiwi(f: KiwiFlight): UnifiedFlight {
  const returning = kiwiReturnDep(f);
  return {
    id: `kiwi-${f.id}`, priceJPY: f.price, currency: f.currency || "JPY", flyFrom: f.flyFrom, flyTo: f.flyTo, cityFrom: f.cityFrom, cityTo: f.cityTo,
    airlineCode: kiwiAirlines(f) || "?", departureAt: kiwiFirstDep(f), returnAt: returning, nightsInDest: f.nightsInDest ?? 0,
    deep_link: f.deep_link || "", booking_token: f.booking_token || "", raw: f.route, source: "kiwi", itineraryComplete: !!returning, isNonStop: f.isNonStop,
  };
}
export function unifySerp(f: RoundTripSearchResult): UnifiedFlight {
  return {
    id: `serp-${f.id}`, priceJPY: f.price, currency: f.currency || "JPY", flyFrom: f.flyFrom, flyTo: f.flyTo, cityFrom: f.cityFrom, cityTo: f.cityTo,
    airlineCode: Array.from(new Set(f.airlines.filter(c => c && c !== "ALL"))).join(",") || "?",
    departureAt: f.local_departure, returnAt: f.return_departure, nightsInDest: f.nightsInDest ?? 0,
    deep_link: f.deep_link || "", booking_token: f.booking_token || "", raw: f.route, source: "serpapi", itineraryComplete: f.itineraryComplete === true, isNonStop: f.isNonStop,
  };
}
function unifyOffer(f: AmadeusRoundTrip | SkyscannerRoundTrip, source: "amadeus" | "skyscanner"): UnifiedFlight {
  return {
    id: `${source}-${f.id}`, priceJPY: f.price, currency: f.currency, flyFrom: f.flyFrom, flyTo: f.flyTo, cityFrom: f.cityFrom, cityTo: f.cityTo,
    airlineCode: f.airlines.join(",") || "?", departureAt: f.local_departure, returnAt: f.return_departure, nightsInDest: f.nightsInDest,
    deep_link: f.deep_link || "", booking_token: f.booking_token || "", raw: f.route, source, itineraryComplete: f.itineraryComplete === true, isNonStop: f.isNonStop,
  };
}
export type SearchMode = "full" | "light";
export type SearchStatus = "success" | "partial" | "failed";
export interface SearchResult {
  success: boolean; status: SearchStatus; error?: string; warnings: string[];
  flightsFound: number; minPrice: number | null; lowestFlight: FlightRecord | null;
  isNewLowest: boolean; previousLowest: number | null; emailSent: boolean; emailError?: string;
  provider: Provider | "mixed" | "none"; mode: SearchMode;
  coverage: {
    sampled: true; requestsMade: number; requestLimit: number; departureDates: string[];
    searchedFrom: string | null; searchedTo: string | null;
  };
}
export function validateSearchConfig(search: SearchConfig): void {
  if (typeof search.nonStopOnly !== "boolean") throw new Error("直飞筛选须为开或关。");
  if (!/^[A-Z]{3}$/.test(search.flyFrom) || !/^[A-Z]{3}$/.test(search.flyTo) || search.flyFrom === search.flyTo) throw new Error("请提供不同的有效出发和到达机场代码。");
  if (!Number.isInteger(search.searchDaysAhead) || search.searchDaysAhead < 1 || search.searchDaysAhead > 365) throw new Error("搜索天数须为 1–365。");
  if (!Number.isInteger(search.minNights) || !Number.isInteger(search.maxNights) || search.minNights < 0 || search.maxNights > 90 || search.minNights > search.maxNights) throw new Error("停留晚数须为 0–90，且最小值不能大于最大值。");
  if (!Number.isInteger(search.adults) || search.adults < 1 || search.adults > 9) throw new Error("成人数须为 1–9。");
  if (!Array.isArray(search.selectAirlines) || search.selectAirlines.some(s => !/^[A-Z0-9]{2}$/.test(s))) throw new Error("航司代码须为两位字母或数字。");
  if (search.maxPriceJPY != null && (!Number.isFinite(search.maxPriceJPY) || search.maxPriceJPY <= 0)) throw new Error("最高票价须为正数。");
}
function configured(value: string) { return !!value.trim() && !/^(your[_-]|replace[_-]|example|fixture)/i.test(value.trim()); }

export async function runFullSearch(cfg?: AppConfig, mode: SearchMode = "full", options: { budget?: SearchBudget } = {}): Promise<SearchResult> {
  const original = cfg ?? loadConfig();
  const config: AppConfig = { ...original, search: { ...original.search, mode,
    flyFrom: original.search.flyFrom.trim().toUpperCase(), flyTo: original.search.flyTo.trim().toUpperCase(),
    selectAirlines: original.search.selectAirlines.map(s => s.trim().toUpperCase()),
  } };
  validateSearchConfig(config.search);
  await getDb(); // Storage must be ready before a paid provider request is attempted.
  const startedAt = new Date().toISOString();
  const budget = options.budget ?? new SearchBudget(mode === "light" ? 10 : 16, mode === "light" ? 12_000 : 20_000);
  const requestLimit = budget.requestLimit;
  const jobs: Array<{ source: Provider; run: (scope: SearchBudget) => Promise<UnifiedFlight[]> }> = [];
  if (configured(config.serpApiKey)) jobs.push({ source: "serpapi", run: async b => (await serpSearch(config.serpApiKey, config.search, b)).map(unifySerp) });
  if (configured(config.kiwiApiKey)) jobs.push({ source: "kiwi", run: async b => (await kiwiSearch(config.kiwiApiKey, config.search, b)).map(unifyKiwi) });
  if (configured(config.rapidapiKey)) jobs.push({ source: "skyscanner", run: async b => (await skySearch(config.rapidapiKey, config.search, b)).map(f => unifyOffer(f, "skyscanner")) });
  if (configured(config.amadeusClientId) && configured(config.amadeusClientSecret)) jobs.push({ source: "amadeus", run: async b => (await amadeusSearch(config.amadeusClientId, config.amadeusClientSecret, config.search, { lightweight: mode === "light", budget: b })).map(f => unifyOffer(f, "amadeus")) });
  const collected: UnifiedFlight[] = [];
  if (!jobs.length) budget.warn("尚未配置有效的航班数据供应商密钥。");
  for (let i = 0; i < jobs.length; i++) {
    if (!budget.checkTime()) break;
    const remainingProviders = jobs.length - i;
    const scope = budget.scope(jobs[i].source, Math.max(1, Math.floor(budget.remainingRequests / remainingProviders)), Math.floor(budget.remainingMs / remainingProviders));
    try { collected.push(...await jobs[i].run(scope)); }
    catch { scope.warn("供应商搜索未能完成。"); }
  }
  const unique = new Map<string, UnifiedFlight>();
  for (const f of collected) {
    if (config.search.nonStopOnly && f.isNonStop !== true) continue;
    if (!f.itineraryComplete) { budget.warn("缺少已确认返程的报价已排除，不参与最低价和通知。"); continue; }
    if (!Number.isFinite(f.priceJPY) || f.priceJPY <= 0 || f.currency !== "JPY" || !Number.isFinite(Date.parse(f.departureAt)) || !Number.isFinite(Date.parse(f.returnAt)) || !Number.isInteger(f.nightsInDest)) {
      budget.warn("供应商返回了无效价格或行程日期，该报价已排除。"); continue;
    }
    if (!matchesAirlines(f.airlineCode.split(","), config.search.selectAirlines)) continue;
    if (config.search.maxPriceJPY != null && f.priceJPY > config.search.maxPriceJPY) continue;
    if (f.nightsInDest < config.search.minNights || f.nightsInDest > config.search.maxNights) continue;
    const key = JSON.stringify([f.flyFrom, f.flyTo, f.departureAt, f.returnAt, f.airlineCode, f.priceJPY]);
    if (!unique.has(key)) unique.set(key, f);
  }
  if (unique.size > 50) budget.warn("本次仅保留票价最低的 50 条已确认结果。");
  const flights = Array.from(unique.values()).sort((a, b) => a.priceJPY - b.priceJPY).slice(0, 50);
  const warnings = budget.warnings;
  const status: SearchStatus = warnings.length ? (flights.length ? "partial" : "failed") : "success";
  const error = status === "failed" ? warnings.join(" ") : undefined;
  const records = flights.map(f => ({
    price: f.priceJPY, currency: f.currency, fly_from: config.search.flyFrom, fly_to: config.search.flyTo,
    airline: f.airlineCode, airline_name: getAirlineName(f.airlineCode), departure_at: f.departureAt, return_at: f.returnAt,
    nights_in_dest: f.nightsInDest, booking_token: f.booking_token.slice(0, 2000), deep_link: safeBookingLink(f.deep_link),
    raw_data: JSON.stringify({ source: f.source, metadata: { itineraryComplete: f.itineraryComplete, isNonStop: f.isNonStop === true,
      actualOrigin: f.flyFrom, actualDestination: f.flyTo }, providerFlightId: f.id.slice(0, 300) }),
  }));
  const stored = await persistSearchRun({
    started_at: startedAt, finished_at: new Date().toISOString(), flights_found: flights.length,
    min_price: flights[0]?.priceJPY ?? null, status, error_message: warnings.length ? warnings.join(" ").slice(0, 2000) : null,
  }, records);
  const lowestFlight: FlightRecord | null = records.length ? {
    ...records[0], id: stored.flightRecordIds[0], search_run_id: stored.searchRunId, created_at: new Date().toISOString(),
  } : null;
  let previousLowest: number | null = null;
  let isNewLowest = false;
  let emailSent = false;
  let emailError: string | undefined;
  if (lowestFlight) {
    const lowestUpdate = await upsertLowestPrice({
      fly_from: lowestFlight.fly_from, fly_to: lowestFlight.fly_to, non_stop_only: config.search.nonStopOnly, min_price: lowestFlight.price, currency: lowestFlight.currency,
      airline: lowestFlight.airline, departure_at: lowestFlight.departure_at, return_at: lowestFlight.return_at,
      nights_in_dest: lowestFlight.nights_in_dest, deep_link: lowestFlight.deep_link, flight_record_id: lowestFlight.id!,
    });
    previousLowest = lowestUpdate.previousLowest;
    isNewLowest = lowestUpdate.isNewLowest;
    if (config.email.enabled) {
      try {
        const pendingRetry = await hasFailedNotification(lowestFlight, config.email.emailTo);
        if (isNewLowest || lowestFlight.price <= config.email.alertPriceJPY || pendingRetry) {
          const claim = await claimNotification(lowestFlight, config.email.emailTo, 12);
          if (claim) {
            try {
              await sendAlertEmail(config.email, lowestFlight, isNewLowest, previousLowest);
              emailSent = true;
            } catch {
              emailError = "邮件发送失败，请检查邮件配置与服务连接。";
              await releaseNotificationClaim(claim);
            }
            await insertNotificationLog({ flight_record_id: lowestFlight.id!, recipient: config.email.emailTo,
              price: lowestFlight.price, success: emailSent ? 1 : 0, error_message: emailError ?? null });
          }
        }
      } catch {
        emailError = emailSent ? "邮件已发送，但通知记录未能保存。" : (emailError || "通知状态未能保存，邮件未发送；搜索结果已保存。");
      }
    }
  }
  const providers = Array.from(new Set(flights.map(f => f.source)));
  const departureDates = budget.departureDates;
  return {
    success: status !== "failed", status, error, warnings, flightsFound: flights.length,
    minPrice: lowestFlight?.price ?? null, lowestFlight, isNewLowest, previousLowest, emailSent, emailError,
    provider: providers.length > 1 ? "mixed" : providers[0] ?? "none", mode,
    coverage: { sampled: true, requestsMade: budget.requestsMade, requestLimit, departureDates,
      searchedFrom: departureDates[0] ?? null, searchedTo: departureDates[departureDates.length - 1] ?? null },
  };
}
export type { SearchConfig };
