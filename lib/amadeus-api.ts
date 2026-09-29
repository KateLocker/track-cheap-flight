import axios from "axios";
import { addDays, format } from "date-fns";
import type { SearchConfig } from "./config";
import { SearchBudget, sampleDepartureDates, sampleNights, dateText, matchesAirlines, calendarNights } from "./search-budget";

export interface AmadeusSegment {
  operating?: { carrierCode?: string };
  carrierCode?: string;
  number?: string;
  departure?: { iataCode?: string; at?: string };
  arrival?: { iataCode?: string; at?: string };
  duration?: string;
  numberOfStops?: number;
}

export interface AmadeusFlightOffer {
  id: string;
  price?: { total?: string; currency?: string; base?: string; grandTotal?: string };
  validatingAirlineCodes?: string[];
  travelerPricings?: Array<{ fareDetailsBySegment?: Array<{ airline?: string; segmentId?: string; cabin?: string; brandedFare?: string; class?: string }> }>;
  itineraries?: Array<{
    duration?: string;
    segments: AmadeusSegment[];
  }>;
}

export interface AmadeusRoundTrip {
  id: string;
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
  route: AmadeusSegment[];
  itineraryComplete?: boolean;
  isNonStop?: boolean;
}

const BASE = "https://api.amadeus.com";
let cachedToken: { token: string; expiresAt: number; clientId: string; clientSecret: string } | null = null;
async function getAccessToken(clientId: string, clientSecret: string, budget: SearchBudget): Promise<string> {
  if (cachedToken && cachedToken.clientId === clientId && cachedToken.clientSecret === clientSecret && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const response = await budget.request(options => axios.post(`${BASE}/v1/security/oauth2/token`, new URLSearchParams({
    grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret,
  }), { ...options, headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
  if (!response.data.access_token) throw new Error("Amadeus authentication failed");
  cachedToken = { token: response.data.access_token, expiresAt: Date.now() + response.data.expires_in * 1000, clientId, clientSecret };
  return cachedToken.token;
}

export async function searchAmadeusOneWay(clientId: string, clientSecret: string, params: {
  originLocationCode: string; destinationLocationCode: string; departureDateRangeStart: Date; departureDateRangeEnd: Date;
  adults?: number; nonStop?: boolean; maxPrice?: number; includedAirlineCodes?: string[]; currencyCode?: string; max?: number;
}, budget = new SearchBudget(8)): Promise<AmadeusFlightOffer[]> {
  const token = await getAccessToken(clientId, clientSecret, budget);
  const results: AmadeusFlightOffer[] = [];
  const span = Math.max(0, Math.round((params.departureDateRangeEnd.getTime() - params.departureDateRangeStart.getTime()) / 86400000));
  const count = Math.min(span + 1, budget.remainingRequests);
  for (let i = 0; i < count && budget.checkTime(); i++) {
    const day = addDays(params.departureDateRangeStart, count === 1 ? 0 : Math.round(i * span / (count - 1)));
    try {
      const response = await budget.request(options => axios.get(`${BASE}/v2/shopping/flight-offers`, { ...options, headers: { Authorization: `Bearer ${token}` }, params: {
        originLocationCode: params.originLocationCode, destinationLocationCode: params.destinationLocationCode, departureDate: dateText(day),
        adults: params.adults ?? 1, currencyCode: params.currencyCode ?? "JPY", max: params.max ?? 5, maxPrice: params.maxPrice,
        includedAirlineCodes: params.includedAirlineCodes?.join(",") || undefined, nonStop: params.nonStop ?? false,
      } }));
      if (Array.isArray(response.data.data)) results.push(...response.data.data);
    } catch { /* Already recorded by the shared budget; retain earlier dates. */ }
  }
  return results;
}

export async function searchRoundTripFlexible(
  clientId: string, clientSecret: string, cfg: SearchConfig,
  options: { lightweight?: boolean; budget?: SearchBudget } = {}
): Promise<AmadeusRoundTrip[]> {
  const budget = options.budget ?? new SearchBudget(options.lightweight ? 10 : 16);
  if (process.env.AMADEUS_ENV === "test") {
    budget.warn("测试环境报价不会用于监控；请配置生产环境凭据。");
    return [];
  }
  const results: AmadeusRoundTrip[] = [];
  const token = await getAccessToken(clientId, clientSecret, budget);
  const dates = sampleDepartureDates(cfg.searchDaysAhead, budget.remainingRequests);
  const nights = sampleNights(cfg.minNights, cfg.maxNights);
  const seen = new Set<string>();
  for (let i = 0; i < dates.length && budget.checkTime(); i++) {
    const departDate = dateText(dates[i]);
    const returnDate = dateText(addDays(dates[i], nights[i % nights.length]));
    budget.recordDate(departDate);
    try {
      const response = await budget.request(requestOptions => axios.get(`${BASE}/v2/shopping/flight-offers`, {
        ...requestOptions, headers: { Authorization: `Bearer ${token}` }, params: {
          originLocationCode: cfg.flyFrom, destinationLocationCode: cfg.flyTo, departureDate: departDate, returnDate,
          adults: cfg.adults, currencyCode: "JPY", max: 15, maxPrice: cfg.maxPriceJPY ?? undefined,
          includedAirlineCodes: cfg.selectAirlines.join(",") || undefined, nonStop: cfg.nonStopOnly,
        },
      }));
      for (const offer of (response.data.data ?? []) as AmadeusFlightOffer[]) {
        const out = offer.itineraries?.[0]?.segments ?? [];
        const inbound = offer.itineraries?.[1]?.segments ?? [];
        const dep = out[0]?.departure?.at;
        const ret = inbound[0]?.departure?.at;
        if (!dep || !ret) continue;
        const route = [...out, ...inbound];
        const isNonStop = offer.itineraries?.length === 2 && out.length === 1 && inbound.length === 1
          && route.every(segment => segment.numberOfStops === 0 && !!segment.departure?.iataCode
            && !!segment.arrival?.iataCode && !!segment.departure?.at && !!segment.arrival?.at);
        if (cfg.nonStopOnly && !isNonStop) continue;
        const airlines = Array.from(new Set(route.map(s => s.operating?.carrierCode || s.carrierCode || "?")));
        if (!matchesAirlines(airlines, cfg.selectAirlines)) continue;
        const price = Number(offer.price?.grandTotal || offer.price?.total);
        if (!Number.isFinite(price) || price <= 0 || offer.price?.currency !== "JPY" || (cfg.maxPriceJPY != null && price > cfg.maxPriceJPY)) continue;
        const actualNights = calendarNights(dep, ret);
        if (actualNights < cfg.minNights || actualNights > cfg.maxNights) continue;
        const id = JSON.stringify([dep, ret, route.map(s => [s.carrierCode, s.number]), price]);
        if (seen.has(id)) continue;
        seen.add(id);
        results.push({
          id, price, currency: "JPY", flyFrom: cfg.flyFrom, flyTo: cfg.flyTo, cityFrom: cfg.flyFrom, cityTo: cfg.flyTo,
          local_departure: dep, local_arrival: out[out.length - 1]?.arrival?.at || "",
          return_departure: ret, return_arrival: inbound[inbound.length - 1]?.arrival?.at || "",
          airlines, nightsInDest: actualNights, deep_link: "", booking_token: offer.id, route, itineraryComplete: true, isNonStop,
        });
      }
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status === 401 || status === 403 || status === 429) break;
    }
  }
  return results.sort((a, b) => a.price - b.price);
}
