import type { AppConfig } from "./config";

export class InputError extends Error {}

export async function readJSONObject(request: Request, maximumBytes = 16_384): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximumBytes) throw new InputError("Request body is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new InputError("Request body is too large.");
  if (!text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new InputError("Request body must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Request body must be a JSON object.");
  return value as Record<string, unknown>;
}

export function airportCode(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value.trim())) {
    throw new InputError(`${field} must be one three-letter airport or city code.`);
  }
  return value.trim().toUpperCase();
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !/^\d+$/.test(value))) {
    throw new InputError(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new InputError(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

export function validateSearchRequest(body: Record<string, unknown>, defaults: AppConfig): AppConfig {
  const allowed = new Set(["flyFrom", "flyTo", "searchDaysAhead", "minNights", "maxNights", "adults", "selectAirlines", "nonStopOnly", "maxPriceJPY", "alertPriceJPY", "mode"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new InputError(`Unknown search field: ${key}.`);
  const values: Record<string, unknown> = { ...defaults.search, ...body };
  const flyFrom = airportCode(values.flyFrom, "flyFrom");
  const flyTo = airportCode(values.flyTo, "flyTo");
  if (flyFrom === flyTo) throw new InputError("Departure and destination must be different.");
  const minNights = integer(values.minNights, "minNights", 0, 90);
  const maxNights = integer(values.maxNights, "maxNights", 0, 90);
  if (minNights > maxNights) throw new InputError("minNights must not exceed maxNights.");
  const rawAirlines = typeof values.selectAirlines === "string" ? values.selectAirlines.split(/[,，\s]+/).filter(Boolean) : values.selectAirlines;
  if (!Array.isArray(rawAirlines) || rawAirlines.length > 20 || rawAirlines.some(code => typeof code !== "string" || !/^[A-Za-z0-9]{2}$/.test(code))) {
    throw new InputError("selectAirlines must contain up to 20 two-character airline codes.");
  }
  if (values.mode !== undefined && values.mode !== "light" && values.mode !== "full") throw new InputError("mode must be light or full.");
  if (typeof values.nonStopOnly !== "boolean") throw new InputError("nonStopOnly must be true or false.");
  return {
    ...defaults,
    search: {
      flyFrom, flyTo, minNights, maxNights,
      searchDaysAhead: integer(values.searchDaysAhead, "searchDaysAhead", 1, 365),
      adults: integer(values.adults, "adults", 1, 9),
      selectAirlines: [...new Set(rawAirlines.map(code => (code as string).toUpperCase()))],
      nonStopOnly: values.nonStopOnly,
      maxPriceJPY: values.maxPriceJPY == null || values.maxPriceJPY === "" ? null : integer(values.maxPriceJPY, "maxPriceJPY", 1, 10_000_000),
      mode: values.mode === "light" ? "light" : "full",
    },
    email: {
      ...defaults.email,
      alertPriceJPY: integer(body.alertPriceJPY ?? defaults.email.alertPriceJPY, "alertPriceJPY", 1, 10_000_000),
    },
  };
}
