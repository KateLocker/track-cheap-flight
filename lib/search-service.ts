import { loadConfig, AppConfig, SearchConfig } from "./config";
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
  searchRoundTripFlexible as amadeusSearch,
  AmadeusRoundTrip,
} from "./amadeus-api";
import {
  searchRoundTripFlexible as skySearch,
  SkyscannerRoundTrip,
} from "./skyscanner-api";
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
  source: "kiwi" | "serpapi" | "amadeus";
}

function unifyKiwi(f: KiwiFlight): UnifiedFlight {
  const airlineCode =
    kiwiAirlines(f).split(",")[0] || f.airlines[0] || "?";
  return {
    id: `kiwi-${f.id}`,
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
    source: "kiwi",
  };
}

function unifySerp(f: RoundTripSearchResult): UnifiedFlight {
  const airlineCode =
    serpAirlines(f).split(",")[0] || f.airlines[0] || "?";
  return {
    id: `serp-${f.id}`,
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
    source: "serpapi",
  };
}

function unifyAmadeus(f: AmadeusRoundTrip): UnifiedFlight {
  const airlineCode = f.airlines[0] || "?";
  return {
    id: `amd-${f.id}`,
    priceJPY: f.price,
    currency: f.currency || "JPY",
    flyFrom: f.flyFrom,
    flyTo: f.flyTo,
    cityFrom: f.cityFrom,
    cityTo: f.cityTo,
    airlineCode,
    departureAt: f.local_departure,
    returnAt: f.return_departure,
    nightsInDest: f.nightsInDest || 0,
    deep_link: f.deep_link || "",
    booking_token: f.booking_token || "",
    raw: f.route.slice(0, 10),
    source: "amadeus",
  };
}

function unifySky(f: SkyscannerRoundTrip): UnifiedFlight {
  const airlineCode = f.airlines[0] || "?";
  return {
    id: `sky-${f.id}`,
    priceJPY: f.price,
    currency: f.currency || "JPY",
    flyFrom: f.flyFrom,
    flyTo: f.flyTo,
    cityFrom: f.cityFrom,
    cityTo: f.cityTo,
    airlineCode,
    departureAt: f.local_departure,
    returnAt: f.return_departure,
    nightsInDest: f.nightsInDest || 0,
    deep_link: f.deep_link || "",
    booking_token: f.booking_token || "",
    raw: (f.route || []).slice(0, 10),
    source: "skyscanner",
  };
}

export type SearchMode = "full" | "light";

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
  provider?: "kiwi" | "serpapi" | "amadeus" | "skyscanner" | "mixed" | "none";
  mode?: SearchMode;
}

async function collectKiwi(
  cfg: AppConfig,
  flights: UnifiedFlight[],
  errors: string[]
) {
  if (!cfg.kiwiApiKey) return;
  try {
    const r = await kiwiSearch(cfg.kiwiApiKey, cfg.search);
    for (const f of r) flights.push(unifyKiwi(f));
  } catch (e) {
    errors.push(`Kiwi: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function collectSerp(
  cfg: AppConfig,
  flights: UnifiedFlight[],
  errors: string[]
) {
  if (!cfg.serpApiKey) return;
  try {
    const r = await serpSearch(cfg.serpApiKey, cfg.search);
    for (const f of r) flights.push(unifySerp(f));
  } catch (e) {
    errors.push(`SerpAPI: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function collectAmadeus(
  cfg: AppConfig,
  flights: UnifiedFlight[],
  errors: string[],
  mode: SearchMode
) {
  if (!cfg.amadeusClientId || !cfg.amadeusClientSecret) return;
  try {
    const r = await amadeusSearch(
      cfg.amadeusClientId,
      cfg.amadeusClientSecret,
      cfg.search,
      { lightweight: mode === "light" }
    );
    for (const f of r) flights.push(unifyAmadeus(f));
  } catch (e) {
    errors.push(
      `Amadeus: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

async function collectSky(
  cfg: AppConfig,
  flights: UnifiedFlight[],
  errors: string[]
) {
  if (!cfg.rapidapiKey) return;
  try {
    const r = await skySearch(cfg.rapidapiKey, cfg.search);
    for (const f of r) flights.push(unifySky(f));
  } catch (e) {
    errors.push(
      `Skyscanner(Rapid): ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

export async function runFullSearch(
  cfg?: AppConfig,
  mode: SearchMode = "full"
): Promise<SearchResult> {
  const config = cfg ?? loadConfig();
  const startedAt = new Date().toISOString();

  const flights: UnifiedFlight[] = [];
  const errors: string[] = [];
  const providerSet = new Set<
    "kiwi" | "serpapi" | "amadeus" | "skyscanner"
  >();

  const useSerp = !!config.serpApiKey && config.serpApiKey.length > 5;
  const useSky = !!config.rapidapiKey && config.rapidapiKey.length > 5;
  const useAmadeus =
    !!config.amadeusClientId && !!config.amadeusClientSecret;
  const useKiwi =
    !!config.kiwiApiKey && !config.kiwiApiKey.includes("your_kiwi");

  try {
    if (useSky) {
      await collectSky(config, flights, errors);
      if (flights.some((f) => f.source === "skyscanner"))
        providerSet.add("skyscanner");
    }
  } catch {
    /* ignore outer */
  }

  try {
    if (useSerp && flights.length < 15) {
      await collectSerp(config, flights, errors);
      if (flights.some((f) => f.source === "serpapi"))
        providerSet.add("serpapi");
    }
  } catch {
    /* ignore outer */
  }

  try {
    if (
      useAmadeus &&
      (mode === "light" || flights.length < 5)
    ) {
      await collectAmadeus(config, flights, errors, mode);
      if (flights.some((f) => f.source === "amadeus"))
        providerSet.add("amadeus");
    }
  } catch {
    /* ignore outer */
  }

  try {
    if (useKiwi && flights.length < 5) {
      await collectKiwi(config, flights, errors);
      if (flights.some((f) => f.source === "kiwi"))
        providerSet.add("kiwi");
    }
  } catch {
    /* ignore outer */
  }

  flights.sort((a, b) => a.priceJPY - b.priceJPY);

  let minPrice: number | null = null;
  const savedRecordIds: number[] = [];
  let combinedErr: string | null = null;

  if (
    flights.length === 0 &&
    !useSerp &&
    !useKiwi &&
    !useAmadeus &&
    !useSky
  ) {
    combinedErr =
      "RAPIDAPI_KEY / SERPAPI_KEY / KIWI_API_KEY / AMADEUS_CLIENT_ID+SECRET のいずれかを Vercel Environment Variables に設定してください。";
  } else if (flights.length === 0) {
    if (errors.length > 0) combinedErr = errors.join(" | ").slice(0, 900);
  }

  const searchRunId = insertSearchRun({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    flights_found: flights.length,
    min_price: flights[0]?.priceJPY ?? null,
    status: combinedErr
      ? flights.length > 0
        ? "partial"
        : "failed"
      : "success",
    error_message: combinedErr,
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
        raw_data:
          typeof f.raw === "string"
            ? f.raw
            : JSON.stringify({ source: f.source, data: f.raw }).slice(0, 8000),
      });
      savedRecordIds.push(id);
    } catch {
      // skip
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

    const existing = getLatestLowestPrice(
      config.search.flyFrom,
      config.search.flyTo
    );
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

    const needAlertByThreshold =
      cheapest.priceJPY <= config.email.alertPriceJPY;
    const needAlertByNewLow = isNewLowest && config.email.enabled;

    if (
      lowestFlight &&
      (needAlertByThreshold || needAlertByNewLow) &&
      config.email.enabled
    ) {
      const recentCount = getRecentNotifications(lowestFlight.id!, 12);
      if (recentCount === 0) {
        try {
          await sendAlertEmail(
            config.email,
            lowestFlight,
            isNewLowest,
            previousLowest
          );
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

  let provider: SearchResult["provider"] = "none";
  if (providerSet.size > 1) provider = "mixed";
  else if (providerSet.size === 1)
    provider = Array.from(providerSet)[0] as SearchResult["provider"];

  return {
    success: !combinedErr || flights.length > 0,
    error: combinedErr ?? undefined,
    flightsFound: flights.length,
    minPrice,
    lowestFlight,
    isNewLowest,
    previousLowest,
    emailSent,
    emailError,
    provider,
    mode,
  };
}

export type { SearchConfig };
