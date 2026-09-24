import axios from "axios";
import { addDays, format } from "date-fns";
import type { SearchConfig } from "./config";

export interface AmadeusSegment {
  operating?: { carrierCode?: string };
  carrierCode?: string;
  number?: string;
  departure?: { iataCode?: string; at?: string };
  arrival?: { iataCode?: string; at?: string };
  duration?: string;
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
  route: any[];
}

const AMADEUS_AUTH_URL = "https://test.api.amadeus.com/v1/security/oauth2/token";
const AMADEUS_SHOPPING_URL = "https://test.api.amadeus.com/v2/shopping/flight-offers";
const AMADEUS_SEARCH_MAX_DAYS_DIRECT = 7;

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - now > 60_000) {
    return cachedToken.token;
  }

  const resp = await axios.post(
    AMADEUS_AUTH_URL,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30_000,
    }
  );

  const data = resp.data as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

export async function searchAmadeusOneWay(
  clientId: string,
  clientSecret: string,
  params: {
    originLocationCode: string;
    destinationLocationCode: string;
    departureDateRangeStart: Date;
    departureDateRangeEnd: Date;
    adults?: number;
    nonStop?: boolean;
    maxPrice?: number;
    includedAirlineCodes?: string[];
    currencyCode?: string;
    max?: number;
  }
): Promise<AmadeusFlightOffer[]> {
  const token = await getAccessToken(clientId, clientSecret);
  const total: AmadeusFlightOffer[] = [];

  const starts: Date[] = [];
  let cur = new Date(params.departureDateRangeStart);
  const maxEnd = new Date(params.departureDateRangeEnd);
  const stepDays = 1;
  while (cur <= maxEnd && starts.length < AMADEUS_SEARCH_MAX_DAYS_DIRECT) {
    starts.push(new Date(cur));
    cur = addDays(cur, stepDays);
  }

  for (const dep of starts) {
    try {
      const queryParams: Record<string, unknown> = {
        originLocationCode: params.originLocationCode,
        destinationLocationCode: params.destinationLocationCode,
        departureDate: format(dep, "yyyy-MM-dd"),
        adults: params.adults ?? 1,
        nonStop: params.nonStop === true ? "true" : "false",
        currencyCode: params.currencyCode ?? "JPY",
        max: params.max ?? 5,
      };
      if (params.includedAirlineCodes && params.includedAirlineCodes.length > 0) {
        queryParams.includedAirlineCodes = params.includedAirlineCodes.join(",");
      }
      if (params.maxPrice && params.maxPrice > 0) {
        queryParams.maxPrice = params.maxPrice;
      }

      const resp = await axios.get(AMADEUS_SHOPPING_URL, {
        params: queryParams,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 40_000,
      });
      const data = resp.data as {
        data?: AmadeusFlightOffer[];
        meta?: unknown;
        dictionaries?: unknown;
      };
      if (data?.data && Array.isArray(data.data)) {
        for (const f of data.data) total.push(f);
      }
    } catch {
      /* ignore single day error */
    }
  }

  total.sort((a, b) => {
    const ap = parseFloat(a.price?.grandTotal || a.price?.total || "999999");
    const bp = parseFloat(b.price?.grandTotal || b.price?.total || "999999");
    return ap - bp;
  });
  return total;
}

function firstCarrier(offer: AmadeusFlightOffer, idx: number): string {
  const itin = offer.itineraries?.[idx];
  if (!itin || !itin.segments || itin.segments.length === 0) return "?";
  const seg = itin.segments[0];
  return (
    seg.operating?.carrierCode || seg.carrierCode || offer.validatingAirlineCodes?.[0] || "?"
  );
}

export async function searchRoundTripFlexible(
  clientId: string,
  clientSecret: string,
  config: SearchConfig,
  options: { lightweight?: boolean } = {}
): Promise<AmadeusRoundTrip[]> {
  const today = new Date();
  const lightweight = !!options.lightweight;
  const windows: Array<{ start: Date; end: Date }> = [];

  const ahead = lightweight
    ? Math.min(config.searchDaysAhead, 30)
    : config.searchDaysAhead;
  const maxDeparture = addDays(today, ahead);
  const windowDays = lightweight ? 3 : Math.min(5, Math.max(3, Math.ceil(ahead / 10)));

  let cur = new Date(today);
  let idx = 0;
  while (cur < maxDeparture && idx < (lightweight ? 2 : 4)) {
    const end = addDays(cur, windowDays);
    windows.push({
      start: new Date(cur),
      end: end < maxDeparture ? end : new Date(maxDeparture),
    });
    cur = addDays(cur, windowDays + 1);
    idx++;
  }

  const results: AmadeusRoundTrip[] = [];
  const seen = new Set<string>();

  for (const w of windows) {
    try {
      const outs = await searchAmadeusOneWay(clientId, clientSecret, {
        originLocationCode: config.flyFrom,
        destinationLocationCode: config.flyTo,
        departureDateRangeStart: w.start,
        departureDateRangeEnd: w.end,
        adults: config.adults,
        nonStop: false,
        maxPrice: config.maxPriceJPY ?? undefined,
        includedAirlineCodes: config.selectAirlines,
        currencyCode: "JPY",
        max: lightweight ? 3 : 5,
      });

      if (outs.length === 0) continue;

      for (let i = 0; i < Math.min(outs.length, lightweight ? 2 : 5); i++) {
        const out = outs[i];
        const outSegs = out.itineraries?.[0]?.segments;
        if (!outSegs || outSegs.length === 0) continue;

        const outDepartStr = outSegs[0].departure?.at;
        const outArriveStr = outSegs[outSegs.length - 1].arrival?.at;
        if (!outDepartStr) continue;
        const outDepart = new Date(outDepartStr);
        if (!Number.isFinite(outDepart.getTime())) continue;

        const returnStart = addDays(outDepart, config.minNights);
        const returnEnd = addDays(outDepart, config.maxNights);
        const wEnd = addDays(w.end, config.maxNights);
        if (returnStart > wEnd) continue;
        const realReturnEnd = returnEnd < wEnd ? returnEnd : wEnd;

        try {
          const rets = await searchAmadeusOneWay(clientId, clientSecret, {
            originLocationCode: config.flyTo,
            destinationLocationCode: config.flyFrom,
            departureDateRangeStart: returnStart,
            departureDateRangeEnd: realReturnEnd,
            adults: config.adults,
            nonStop: false,
            currencyCode: "JPY",
            max: lightweight ? 3 : 5,
          });

          for (let j = 0; j < Math.min(rets.length, lightweight ? 2 : 6); j++) {
            const ret = rets[j];
            const retSegs = ret.itineraries?.[0]?.segments;
            if (!retSegs || retSegs.length === 0) continue;
            const retDepartStr = retSegs[0].departure?.at;
            const retArriveStr = retSegs[retSegs.length - 1].arrival?.at;
            if (!retDepartStr) continue;
            const retDepart = new Date(retDepartStr);
            if (!Number.isFinite(retDepart.getTime())) continue;

            const nights = Math.max(
              0,
              Math.round(
                (retDepart.getTime() - outDepart.getTime()) /
                  (1000 * 60 * 60 * 24)
              )
            );
            if (nights < config.minNights || nights > config.maxNights) continue;

            const outPrice = parseFloat(
              out.price?.grandTotal || out.price?.total || "0"
            );
            const retPrice = parseFloat(
              ret.price?.grandTotal || ret.price?.total || "0"
            );
            const total = Math.round(outPrice + retPrice);
            if (!total || total <= 0) continue;
            if (config.maxPriceJPY != null && total > config.maxPriceJPY)
              continue;

            const outCarrier = firstCarrier(out, 0);
            const retCarrier = firstCarrier(ret, 0);
            if (config.selectAirlines.length > 0) {
              const ok1 = config.selectAirlines.some(
                (a) => outCarrier === a
              );
              const ok2 = config.selectAirlines.some(
                (a) => retCarrier === a
              );
              if (!ok1 || !ok2) continue;
            }

            const key = `${format(outDepart, "yyyyMMdd")}|${format(
              retDepart,
              "yyyyMMdd"
            )}|${outCarrier}|${retCarrier}|${Math.floor(total / 1000)}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const airlinesSet = new Set<string>();
            const route: any[] = [];
            for (const s of outSegs) {
              const c = s.operating?.carrierCode || s.carrierCode;
              if (c) airlinesSet.add(c);
              route.push(s);
            }
            for (const s of retSegs) {
              const c = s.operating?.carrierCode || s.carrierCode;
              if (c) airlinesSet.add(c);
              route.push(s);
            }

            results.push({
              id: key,
              price: total,
              currency: "JPY",
              flyFrom: config.flyFrom,
              flyTo: config.flyTo,
              cityFrom: config.flyFrom,
              cityTo: config.flyTo,
              local_departure: outDepartStr,
              local_arrival: outArriveStr || outDepartStr,
              return_departure: retDepartStr,
              return_arrival: retArriveStr || retDepartStr,
              airlines: Array.from(airlinesSet),
              nightsInDest: nights,
              deep_link: "",
              booking_token: `${out.id}|${ret.id}`,
              route,
            });
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  results.sort((a, b) => a.price - b.price);
  return results;
}
