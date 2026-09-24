import { loadConfig, AppConfig } from "./config";
import {
  searchRoundTripFlexible as kiwiSearch,
  KiwiFlight,
  getAirlineCodesFromFlight as kiwiAirlines,
  getFirstLegDeparture as kiwiFirstDep,
  getReturnLegDeparture as kiwiReturnDep,
} from "./kiwi-api";
import {
  searchRoundTripFlexible as serpSearch,
  RoundTripSearchResult,
  getAirlineCodesFromFlight as serpAirlines,
  getFirstLegDeparture as serpFirstDep,
  getReturnLegDeparture as serpReturnDep,
} from "./google-flights-api";
import {
  insertSearchRun,
  insertFlightRecord,
  getLatestLowestPrice,
  upsertLowestPrice,
  insertNotificationLog,
  getRecentNotifications,
  FlightRecord,
} from "./db";
import { sendAlertEmail } from "./email";

const AIRLINE_NAMES: Record<string, string> = {
  NH: "全日空 (ANA)",
  JL: "日本航空 (JAL)",
  CA: "中国国航",
  CZ: "南方航空",
  MU: "東方航空",
  HU: "海南航空",
  "9C": "春秋航空",
  ZH: "深圳航空",
  MF: "厦門航空",
};

export function getAirlineName(code: string): string {
  return AIRLINE_NAMES[code] || code;
}

export interface UnifiedFlight {
  id: string;
  priceJPY: number;
  currency: string;
  flyFrom: string;
  flyTo: string;
  cityFrom: string;
  cityTo: string;
  airlineCode: string;
  departureAt: string;
  returnAt: string;
  nightsInDest: number;
  deep_link: string;
  booking_token: string;
  raw: unknown;
}

function unifyKiwi(f: KiwiFlight): UnifiedFlight {
  const airlineCode = kiwiAirlines(f).split(",")[0] || f.airlines[0] || "?";
  return {
    id: f.id,
    priceJPY: f.price,
    currency: f.currency || "JPY",
    flyFrom: f.flyFrom,
    flyTo: f.flyTo,
    cityFrom: f.cityFrom,
    cityTo: f.cityTo,
    airlineCode,
    departureAt: kiwiFirstDep(f),
    returnAt: kiwiReturnDep(f),
    nightsInDest: f.nightsInDest || 0,
    deep_link: f.deep_link || "",
    booking_token: f.booking_token || "",
    raw: { id: f.id, route: f.route.slice(0, 8) },
  };
}

function unifySerp(f: RoundTripSearchResult): UnifiedFlight {
  const airlineCode = serpAirlines(f).split(",")[0] || f.airlines[0] || "?";
  return {
    id: f.id,
    priceJPY: f.price,
    currency: f.currency || "JPY",
    flyFrom: f.flyFrom,
    flyTo: f.flyTo,
    cityFrom: f.cityFrom,
    cityTo: f.cityTo,
    airlineCode,
    departureAt: serpFirstDep(f),
    returnAt: serpReturnDep(f),
    nightsInDest: f.nightsInDest || 0,
    deep_link: f.deep_link || "",
    booking_token: f.booking_token || "",
    raw: f.route,
  };
}

export interface SearchResult {
  success: boolean;
  error?: string;
  flightsFound: number;
  minPrice: number | null;
  lowestFlight: FlightRecord | null;
  isNewLowest: boolean;
  previousLowest: number | null;
  emailSent: boolean;
  emailError?: string;
  provider?: "kiwi" | "serpapi" | "none";
}

export async function runFullSearch(cfg?: AppConfig): Promise<SearchResult> {
  const config = cfg ?? loadConfig();
  const startedAt = new Date().toISOString();

  let flights: UnifiedFlight[] = [];
  let errorMsg: string | null = null;
  let provider: "kiwi" | "serpapi" | "none" = "none";

  const useSerpapi = !!config.serpApiKey && config.serpApiKey.length > 5;
  const useKiwi = !useSerpapi && !!config.kiwiApiKey && !config.kiwiApiKey.includes("your_kiwi");

  if (useSerpapi) {
    provider = "serpapi";
    try {
      const results = await serpSearch(config.serpApiKey, config.search);
      flights = results.map(unifySerp).sort((a, b) => a.priceJPY - b.priceJPY);
    } catch (err: unknown) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }
  } else if (useKiwi) {
    provider = "kiwi";
    try {
      const results = await kiwiSearch(config.kiwiApiKey, config.search);
      flights = results.map(unifyKiwi).sort((a, b) => a.priceJPY - b.priceJPY);
    } catch (err: unknown) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }
  } else {
    errorMsg =
      "SERPAPI_KEY / KIWI_API_KEY が未設定です。Vercel の Environment Variables に、SerpAPI または Kiwi Tequila の API Key を設定してください。";
  }

  const savedRecordIds: number[] = [];
  let minPrice: number | null = null;

  const searchRunId = insertSearchRun({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    flights_found: flights.length,
    min_price: flights[0]?.priceJPY ?? null,
    status: errorMsg ? (flights.length > 0 ? "partial" : "failed") : "success",
    error_message: errorMsg,
  });

  for (const f of flights) {
    const price = f.priceJPY;
    if (minPrice == null || price < minPrice) minPrice = price;

    try {
      const id = insertFlightRecord({
        search_run_id: searchRunId,
        price,
        currency: f.currency || "JPY",
        fly_from: config.search.flyFrom,
        fly_to: config.search.flyTo,
        airline: f.airlineCode,
        airline_name: getAirlineName(f.airlineCode),
        departure_at: f.departureAt,
        return_at: f.returnAt,
        nights_in_dest: f.nightsInDest || 0,
        booking_token: f.booking_token || "",
        deep_link: f.deep_link || "",
        raw_data: typeof f.raw === "string" ? f.raw : JSON.stringify(f.raw).slice(0, 8000),
      });
      savedRecordIds.push(id);
    } catch (e) {
      // skip on individual insert failure
    }
  }

  const cheapest = flights[0];
  let lowestFlight: FlightRecord | null = null;
  let isNewLowest = false;
  let previousLowest: number | null = null;
  let emailSent = false;
  let emailError: string | undefined = undefined;

  if (cheapest != null && savedRecordIds.length > 0) {
    lowestFlight = {
      search_run_id: searchRunId,
      price: cheapest.priceJPY,
      currency: cheapest.currency || "JPY",
      fly_from: config.search.flyFrom,
      fly_to: config.search.flyTo,
      airline: cheapest.airlineCode,
      airline_name: getAirlineName(cheapest.airlineCode),
      departure_at: cheapest.departureAt,
      return_at: cheapest.returnAt,
      nights_in_dest: cheapest.nightsInDest || 0,
      booking_token: cheapest.booking_token || "",
      deep_link: cheapest.deep_link || "",
      raw_data: "",
      id: savedRecordIds[0],
      created_at: new Date().toISOString(),
    };

    const existing = getLatestLowestPrice(config.search.flyFrom, config.search.flyTo);
    previousLowest = existing?.min_price ?? null;
    isNewLowest = !existing || cheapest.priceJPY < existing.min_price;

    upsertLowestPrice({
      fly_from: config.search.flyFrom,
      fly_to: config.search.flyTo,
      min_price: cheapest.priceJPY,
      currency: cheapest.currency || "JPY",
      airline: cheapest.airlineCode,
      departure_at: cheapest.departureAt,
      return_at: cheapest.returnAt,
      nights_in_dest: cheapest.nightsInDest || 0,
      deep_link: cheapest.deep_link || "",
      flight_record_id: savedRecordIds[0],
    });

    const needAlertByThreshold = cheapest.priceJPY <= config.email.alertPriceJPY;
    const needAlertByNewLow = isNewLowest && config.email.enabled;

    if (lowestFlight && (needAlertByThreshold || needAlertByNewLow) && config.email.enabled) {
      const recentCount = getRecentNotifications(lowestFlight.id!, 12);
      if (recentCount === 0) {
        try {
          await sendAlertEmail(config.email, lowestFlight, isNewLowest, previousLowest);
          emailSent = true;
          insertNotificationLog({
            flight_record_id: lowestFlight.id!,
            recipient: config.email.emailTo,
            price: lowestFlight.price,
            success: 1,
            error_message: null,
          });
        } catch (e) {
          emailError = e instanceof Error ? e.message : String(e);
          insertNotificationLog({
            flight_record_id: lowestFlight.id!,
            recipient: config.email.emailTo,
            price: lowestFlight.price,
            success: 0,
            error_message: emailError,
          });
        }
      }
    }
  }

  return {
    success: !errorMsg || flights.length > 0,
    error: errorMsg ?? undefined,
    flightsFound: flights.length,
    minPrice,
    lowestFlight,
    isNewLowest,
    previousLowest,
    emailSent,
    emailError,
    provider,
  };
}
