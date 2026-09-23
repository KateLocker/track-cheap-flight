import axios from "axios";
import { format, addDays } from "date-fns";
import type { SearchConfig } from "./config";

export interface KiwiFlight {
  id: string;
  price: number;
  currency: string;
  flyFrom: string;
  flyTo: string;
  cityFrom: string;
  cityTo: string;
  local_departure: string;
  local_arrival: string;
  airlines: string[];
  route: Array<{
    airline: string;
    flyFrom: string;
    flyTo: string;
    local_departure: string;
    local_arrival: string;
    flight_no: number;
  }>;
  deep_link: string;
  booking_token: string;
  nightsInDest: number;
  return?: number;
}

export interface KiwiSearchParams {
  flyFrom: string;
  flyTo: string;
  dateFrom: string;
  dateTo: string;
  returnFrom?: string;
  returnTo?: string;
  nightsInDestFrom?: number;
  nightsInDestTo?: number;
  adults?: number;
  selectAirlines?: string;
  selectAirlinesExclude?: boolean;
  maxPrice?: number;
  limit?: number;
  sort?: "price" | "date" | "duration" | "quality";
  vehicle_type?: string;
}

const TEQUILA_BASE = "https://api.tequila.kiwi.com";

function buildHeaders(apiKey: string) {
  return {
    apikey: apiKey,
    Accept: "application/json",
  };
}

export async function searchRoundTripFlexible(
  apiKey: string,
  config: SearchConfig
): Promise<KiwiFlight[]> {
  const today = new Date();
  const maxDate = addDays(today, config.searchDaysAhead);
  const dateFrom = format(today, "dd/MM/yyyy");
  const dateTo = format(maxDate, "dd/MM/yyyy");

  const params: Record<string, unknown> = {
    fly_from: config.flyFrom,
    fly_to: config.flyTo,
    date_from: dateFrom,
    date_to: dateTo,
    return_from: dateFrom,
    return_to: dateTo,
    nights_in_dst_from: config.minNights,
    nights_in_dst_to: config.maxNights,
    adults: config.adults,
    flight_type: "round",
    one_for_city: 0,
    one_per_date: 0,
    only_working_days: false,
    only_weekends: false,
    curr: "JPY",
    locale: "ja",
    sort: "price",
    asc: 1,
    limit: 1000,
    vehicle_type: "aircraft",
  };

  if (config.selectAirlines && config.selectAirlines.length > 0) {
    params["select_airlines"] = config.selectAirlines.join(",");
    params["select_airlines_exclude"] = false;
  }
  if (config.maxPriceJPY != null) {
    params["price_to"] = config.maxPriceJPY;
  }

  try {
    const resp = await axios.get(`${TEQUILA_BASE}/v2/search`, {
      headers: buildHeaders(apiKey),
      params,
      timeout: 60_000,
    });
    const data = resp.data as { data?: KiwiFlight[] };
    return data.data ?? [];
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      const status = err.response.status;
      const body = JSON.stringify(err.response.data);
      throw new Error(
        `Kiwi API HTTP ${status}: ${body.slice(0, 500)}`
      );
    }
    throw err;
  }
}

export function getAirlineCodesFromFlight(f: KiwiFlight): string {
  const set = new Set<string>();
  for (const r of f.route) set.add(r.airline);
  return Array.from(set).join(",");
}

export function getFirstLegDeparture(f: KiwiFlight): string {
  if (f.route.length === 0) return f.local_departure;
  return f.route[0].local_departure;
}

export function getReturnLegDeparture(f: KiwiFlight): string {
  if (!f.return || f.route.length < 2) return f.local_arrival;
  const firstAirline = f.route[0].airline;
  const returnLegIdx = f.route.findIndex(
    (r, i) => i > 0 && r.airline === firstAirline
  );
  if (returnLegIdx > 0) return f.route[returnLegIdx].local_departure;
  const half = Math.floor(f.route.length / 2);
  return f.route[half]?.local_departure ?? f.local_arrival;
}
