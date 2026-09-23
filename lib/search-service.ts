import { loadConfig, AppConfig } from "./config";
import {
  searchRoundTripFlexible,
  KiwiFlight,
  getAirlineCodesFromFlight,
  getFirstLegDeparture,
  getReturnLegDeparture,
} from "./kiwi-api";
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
}

export async function runFullSearch(cfg?: AppConfig): Promise<SearchResult> {
  const config = cfg ?? loadConfig();
  const startedAt = new Date().toISOString();

  let kiwiFlights: KiwiFlight[] = [];
  let errorMsg: string | null = null;

  if (!config.kiwiApiKey || config.kiwiApiKey.includes("your_kiwi")) {
    errorMsg = "KIWI_API_KEY が未設定です。.env に Tequila API Key を設定してください。";
  } else {
    try {
      kiwiFlights = await searchRoundTripFlexible(config.kiwiApiKey, config.search);
    } catch (err: unknown) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }
  }

  const jpyFlights = kiwiFlights
    .map((f) => ({ ...f, priceJPY: f.price }))
    .sort((a, b) => a.priceJPY - b.priceJPY);

  const savedRecordIds: number[] = [];
  let minPrice: number | null = null;

  const searchRunId = insertSearchRun({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    flights_found: jpyFlights.length,
    min_price: jpyFlights[0]?.priceJPY ?? null,
    status: errorMsg ? (jpyFlights.length > 0 ? "partial" : "failed") : "success",
    error_message: errorMsg,
  });

  for (const f of jpyFlights) {
    const airlineCode = getAirlineCodesFromFlight(f).split(",")[0] || f.airlines[0] || "?";
    const departureAt = getFirstLegDeparture(f);
    const returnAt = getReturnLegDeparture(f);
    const price = f.priceJPY;

    if (minPrice == null || price < minPrice) minPrice = price;

    try {
      const id = insertFlightRecord({
        search_run_id: searchRunId,
        price,
        currency: "JPY",
        fly_from: config.search.flyFrom,
        fly_to: config.search.flyTo,
        airline: airlineCode,
        airline_name: getAirlineName(airlineCode),
        departure_at: departureAt,
        return_at: returnAt,
        nights_in_dest: f.nightsInDest || 0,
        booking_token: f.booking_token || "",
        deep_link: f.deep_link || "",
        raw_data: JSON.stringify({ id: f.id, route: f.route.slice(0, 8) }),
      });
      savedRecordIds.push(id);
    } catch (e) {
      // skip on individual insert failure
    }
  }

  const cheapestJPY = jpyFlights[0]?.priceJPY;
  let lowestFlight: FlightRecord | null = null;
  let isNewLowest = false;
  let previousLowest: number | null = null;
  let emailSent = false;
  let emailError: string | undefined = undefined;

  if (cheapestJPY != null && savedRecordIds.length > 0) {
    const cheapestRaw = jpyFlights[0];
    const airlineCode = getAirlineCodesFromFlight(cheapestRaw).split(",")[0] || cheapestRaw.airlines[0] || "?";
    lowestFlight = {
      search_run_id: searchRunId,
      price: cheapestJPY,
      currency: "JPY",
      fly_from: config.search.flyFrom,
      fly_to: config.search.flyTo,
      airline: airlineCode,
      airline_name: getAirlineName(airlineCode),
      departure_at: getFirstLegDeparture(cheapestRaw),
      return_at: getReturnLegDeparture(cheapestRaw),
      nights_in_dest: cheapestRaw.nightsInDest || 0,
      booking_token: cheapestRaw.booking_token || "",
      deep_link: cheapestRaw.deep_link || "",
      raw_data: "",
      id: savedRecordIds[0],
      created_at: new Date().toISOString(),
    };

    const existing = getLatestLowestPrice(config.search.flyFrom, config.search.flyTo);
    previousLowest = existing?.min_price ?? null;
    isNewLowest = !existing || cheapestJPY < existing.min_price;

    upsertLowestPrice({
      fly_from: config.search.flyFrom,
      fly_to: config.search.flyTo,
      min_price: cheapestJPY,
      currency: "JPY",
      airline: airlineCode,
      departure_at: getFirstLegDeparture(cheapestRaw),
      return_at: getReturnLegDeparture(cheapestRaw),
      nights_in_dest: cheapestRaw.nightsInDest || 0,
      deep_link: cheapestRaw.deep_link || "",
      flight_record_id: savedRecordIds[0],
    });

    const needAlertByThreshold = cheapestJPY <= config.email.alertPriceJPY;
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
    success: !errorMsg || jpyFlights.length > 0,
    error: errorMsg ?? undefined,
    flightsFound: jpyFlights.length,
    minPrice,
    lowestFlight,
    isNewLowest,
    previousLowest,
    emailSent,
    emailError,
  };
}
