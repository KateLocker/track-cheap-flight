import path from "node:path";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

export interface FlightRecord {
  id?: number;
  search_run_id: number;
  price: number;
  currency: string;
  fly_from: string;
  fly_to: string;
  airline: string;
  airline_name: string;
  departure_at: string;
  return_at: string;
  nights_in_dest: number;
  booking_token: string;
  deep_link: string;
  raw_data: string;
  created_at?: string;
}

export interface SearchRun {
  id?: number;
  started_at: string;
  finished_at: string;
  flights_found: number;
  min_price: number | null;
  status: "success" | "failed" | "partial";
  error_message: string | null;
}

export interface LowestPriceRecord {
  id?: number;
  non_stop_only?: boolean;
  fly_from: string;
  fly_to: string;
  min_price: number;
  currency: string;
  airline: string;
  departure_at: string;
  return_at: string;
  nights_in_dest: number;
  deep_link: string;
  flight_record_id: number;
  first_seen_at: string;
  last_checked_at: string;
}

export interface NotificationLog {
  id?: number;
  flight_record_id: number;
  sent_at: string;
  recipient: string;
  price: number;
  success: number;
  error_message: string | null;
}

interface NotificationClaim {
  token: string;
  expiresAt: number;
}

interface DataStore {
  searchRuns: SearchRun[];
  flightRecords: FlightRecord[];
  lowestPrices: LowestPriceRecord[];
  notificationLogs: NotificationLog[];
  notificationClaims: Record<string, NotificationClaim>;
  nextId: {
    searchRuns: number;
    flightRecords: number;
    lowestPrices: number;
    notificationLogs: number;
  };
}

type RedisConfig = { url: string; token: string; key: string };
type StorageConfig = { provider: "upstash-redis"; redis: RedisConfig }
  | { provider: "local-json" }
  | { provider: "unconfigured"; reason: string };

function storageConfig(): StorageConfig {
  const upstash = process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_TOKEN;
  const url = upstash ? process.env.UPSTASH_REDIS_REST_URL : process.env.KV_REST_API_URL;
  const token = upstash ? process.env.UPSTASH_REDIS_REST_TOKEN : process.env.KV_REST_API_TOKEN;
  if (url || token) {
    if (!url || !token) return { provider: "unconfigured", reason: "Redis storage requires both its REST URL and token." };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
      return { provider: "upstash-redis", redis: { url: url.replace(/\/$/, ""), token,
        key: process.env.FLIGHT_STORAGE_KEY || "track-cheap-flight:store:v1" } };
    } catch {
      return { provider: "unconfigured", reason: "Redis storage REST URL must be a valid HTTPS URL." };
    }
  }
  if (process.env.VERCEL === "1" || process.env.VERCEL_ENV) {
    return { provider: "unconfigured", reason: "Persistent storage is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN) in Vercel." };
  }
  return { provider: "local-json" };
}

export function getStorageStatus(): { provider: StorageConfig["provider"]; configured: boolean } {
  const config = storageConfig();
  return { provider: config.provider, configured: config.provider !== "unconfigured" };
}

function requireStorage(): Exclude<StorageConfig, { provider: "unconfigured" }> {
  const config = storageConfig();
  if (config.provider === "unconfigured") throw new Error(config.reason);
  return config;
}

function emptyStore(): DataStore {
  return { searchRuns: [], flightRecords: [], lowestPrices: [], notificationLogs: [], notificationClaims: {},
    nextId: { searchRuns: 1, flightRecords: 1, lowestPrices: 1, notificationLogs: 1 } };
}

type Check = (value: unknown) => boolean;
const string: Check = value => typeof value === "string";
const nonempty: Check = value => typeof value === "string" && value.trim().length > 0;
const number: Check = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer: Check = value => number(value) && Number.isSafeInteger(value);
const positiveId: Check = value => integer(value) && (value as number) > 0;
const date: Check = value => typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
// Older provider results can have unavailable travel dates. Preserve them, but reject wrong types.
const travelDate: Check = value => value === "" || date(value);
const safeLink: Check = value => {
  if (value === "") return true;
  if (typeof value !== "string") return false;
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
};
const nullable = (check: Check): Check => value => value === null || check(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function checkObject(value: unknown, required: Record<string, Check>, optional: Record<string, Check> = {}): void {
  if (!isObject(value) || Object.keys(value).some(key => !Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) ||
    Object.entries(required).some(([key, check]) => !Object.hasOwn(value, key) || !check(value[key])) ||
    Object.entries(optional).some(([key, check]) => Object.hasOwn(value, key) && !check(value[key]))) {
    throw new Error("Invalid storage schema");
  }
}

function validateStore(value: unknown): DataStore {
  checkObject(value, { searchRuns: Array.isArray, flightRecords: Array.isArray, lowestPrices: Array.isArray,
    notificationLogs: Array.isArray, nextId: isObject }, { notificationClaims: isObject });
  const store = value as unknown as DataStore;
  const base = { id: positiveId };
  for (const run of store.searchRuns) checkObject(run, { ...base, started_at: date, finished_at: date,
    flights_found: integer, min_price: nullable(number), status: v => ["success", "failed", "partial"].includes(v as string), error_message: nullable(string) });
  for (const flight of store.flightRecords) checkObject(flight, { ...base, search_run_id: positiveId,
    price: number, currency: nonempty, fly_from: nonempty, fly_to: nonempty, airline: string, airline_name: string,
    departure_at: travelDate, return_at: travelDate, nights_in_dest: integer, booking_token: string,
    deep_link: safeLink, raw_data: string }, { created_at: date });
  for (const lowest of store.lowestPrices) checkObject(lowest, { ...base, fly_from: nonempty, fly_to: nonempty,
    min_price: number, currency: nonempty, airline: string, departure_at: travelDate, return_at: travelDate,
    nights_in_dest: integer, deep_link: safeLink, flight_record_id: positiveId, first_seen_at: date, last_checked_at: date },
    { non_stop_only: value => typeof value === "boolean" });
  for (const log of store.notificationLogs) checkObject(log, { ...base, flight_record_id: positiveId,
    sent_at: date, recipient: nonempty, price: number, success: v => v === 0 || v === 1, error_message: nullable(string) });
  checkObject(store.nextId, { searchRuns: positiveId, flightRecords: positiveId, lowestPrices: positiveId, notificationLogs: positiveId });
  for (const collection of ["searchRuns", "flightRecords", "lowestPrices", "notificationLogs"] as const) {
    const ids = store[collection].map(row => row.id!);
    if (new Set(ids).size !== ids.length || ids.some(id => id >= store.nextId[collection])) throw new Error("Invalid storage record IDs");
  }
  const routes = store.lowestPrices.map(row => JSON.stringify([row.fly_from.toUpperCase(), row.fly_to.toUpperCase(), row.non_stop_only === true]));
  if (new Set(routes).size !== routes.length) throw new Error("Duplicate lowest-price routes");
  // Claims were not present in the original JSON format.
  store.notificationClaims ??= {};
  for (const [key, claim] of Object.entries(store.notificationClaims)) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid notification claim key");
    checkObject(claim, { token: v => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v), expiresAt: positiveId });
  }
  return store;
}

function parseStore(raw: string | null): DataStore {
  if (raw === null) return emptyStore();
  try { return validateStore(JSON.parse(raw)); }
  catch { throw new Error("Stored flight data is invalid. Restore a valid backup before continuing; existing data has not been overwritten."); }
}

function dataPath(): string {
  return path.join(process.env.DATA_DIR || path.resolve(process.cwd(), "data"), "flights.json");
}

function hasCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

async function readLocal(file: string): Promise<DataStore> {
  try { return parseStore(await fs.readFile(file, "utf8")); }
  catch (error) { if (hasCode(error, "ENOENT")) return emptyStore(); throw error; }
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function withLocalLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + 10000;
  let lock: Awaited<ReturnType<typeof fs.open>>;
  while (true) {
    try { lock = await fs.open(lockPath, "wx", 0o600); break; }
    catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (Date.now() >= deadline) throw new Error("Local flight data is locked by another process. If no search is running, remove the stale flights.json.lock file in DATA_DIR and retry.");
      await pause(15 + Math.random() * 20);
    }
  }
  try {
    await lock.writeFile(String(process.pid));
    return await action();
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

async function writeLocal(file: string, store: DataStore): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(store), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(error => { if (!hasCode(error, "ENOENT")) throw error; });
  }
}

async function redisCommand(config: RedisConfig, args: Array<string | number>, timeoutMs = 8000): Promise<unknown> {
  const bodyText = JSON.stringify(args);
  if (Buffer.byteLength(bodyText, "utf8") > 9 * 1024 * 1024) {
    throw new Error("Flight history is too large for a safe Redis update (9 MiB request limit). Export a backup and migrate or archive the history before retrying. No records were deleted.");
  }
  let response: Response;
  try {
    response = await fetch(config.url, { method: "POST", headers: { Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json" }, body: bodyText, cache: "no-store", signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))) });
  } catch { throw new Error("Persistent storage request failed or timed out. Retry after checking the Redis connection."); }
  if (!response.ok) throw new Error(`Persistent storage returned HTTP ${response.status}. Check the Redis configuration.`);
  const body: unknown = await response.json().catch(() => null);
  if (!isObject(body) || "error" in body || !Object.hasOwn(body, "result")) throw new Error("Persistent storage command failed or returned an invalid response.");
  return body.result;
}

async function readRemoteRaw(config: RedisConfig, timeoutMs = 8000): Promise<string | null> {
  const raw = await redisCommand(config, ["GET", config.key], timeoutMs);
  if (raw !== null && typeof raw !== "string") throw new Error("Persistent storage returned an invalid record.");
  return raw;
}

// GET + this atomic compare-and-set prevents two serverless instances overwriting each other.
const COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
if (ARGV[1] == '0' and not current) or (ARGV[1] == '1' and current == ARGV[2]) then
  redis.call('SET', KEYS[1], ARGV[3])
  return 1
end
return 0`;

async function readStore(): Promise<DataStore> {
  const config = requireStorage();
  return config.provider === "local-json" ? readLocal(dataPath()) : parseStore(await readRemoteRaw(config.redis));
}

async function mutateStore<T>(change: (store: DataStore) => T, replacement?: DataStore): Promise<T> {
  const config = requireStorage();
  if (config.provider === "local-json") {
    const file = dataPath();
    return withLocalLock(file, async () => {
      const store = replacement ? structuredClone(replacement) : await readLocal(file);
      const result = change(store);
      await writeLocal(file, validateStore(store));
      return result;
    });
  }
  const deadline = Date.now() + 15000;
  for (let attempt = 0; attempt < 32; attempt++) {
    if (Date.now() >= deadline) break;
    const raw = await readRemoteRaw(config.redis, Math.min(8000, deadline - Date.now()));
    const store = replacement ? structuredClone(replacement) : parseStore(raw);
    const result = change(store);
    const next = JSON.stringify(validateStore(store));
    if (Date.now() >= deadline) break;
    const saved = await redisCommand(config.redis, ["EVAL", COMPARE_AND_SET, 1, config.redis.key,
      raw === null ? "0" : "1", raw ?? "", next], Math.min(8000, deadline - Date.now()));
    if (saved === 1) return result;
    if (saved !== 0) throw new Error("Persistent storage returned an invalid write result.");
    await pause(Math.max(0, Math.min(deadline - Date.now(), Math.min(10 * (attempt + 1), 100) + Math.random() * 25)));
  }
  throw new Error("Persistent storage is busy. No update was saved; please retry.");
}

const nowISO = () => new Date().toISOString();
const withinHours = (iso: string, hours: number) => Date.now() - new Date(iso).getTime() <= hours * 3600000;
const matchesRoute = (row: { fly_from: string; fly_to: string }, from?: string, to?: string) =>
  (!from || row.fly_from.toUpperCase() === from.toUpperCase()) && (!to || row.fly_to.toUpperCase() === to.toUpperCase());

export async function getDb(): Promise<{ ready: boolean }> {
  await readStore();
  return { ready: true };
}

export async function insertSearchRun(run: Omit<SearchRun, "id">): Promise<number> {
  return mutateStore(store => { const id = store.nextId.searchRuns++; store.searchRuns.push({ ...run, id }); return id; });
}

export async function insertFlightRecord(rec: Omit<FlightRecord, "id" | "created_at">): Promise<number> {
  return mutateStore(store => { const id = store.nextId.flightRecords++;
    store.flightRecords.push({ ...rec, id, created_at: nowISO() }); return id; });
}

/** Saves a completed search and its results together with one atomic storage update. */
export async function persistSearchRun(
  run: Omit<SearchRun, "id">,
  records: Array<Omit<FlightRecord, "id" | "created_at" | "search_run_id">>,
): Promise<{ searchRunId: number; flightRecordIds: number[] }> {
  return mutateStore(store => {
    const searchRunId = store.nextId.searchRuns++;
    store.searchRuns.push({ ...run, id: searchRunId });
    const created_at = nowISO();
    const flightRecordIds = records.map(record => {
      const id = store.nextId.flightRecords++;
      store.flightRecords.push({ ...record, search_run_id: searchRunId, id, created_at });
      return id;
    });
    return { searchRunId, flightRecordIds };
  });
}

/** Older records without explicit provider confirmation cannot be called nonstop. */
export function isConfirmedNonStop(flight: Pick<FlightRecord, "raw_data">): boolean {
  try {
    const raw: unknown = JSON.parse(flight.raw_data);
    return isObject(raw) && isObject(raw.metadata) && raw.metadata.isNonStop === true;
  } catch { return false; }
}

function historicalLowest(store: DataStore, nonStopOnly: boolean, flyFrom?: string, flyTo?: string): LowestPriceRecord[] {
  const routes = new Map<string, LowestPriceRecord>();
  for (const flight of store.flightRecords) {
    if (!matchesRoute(flight, flyFrom, flyTo) || (nonStopOnly && !isConfirmedNonStop(flight))) continue;
    const key = JSON.stringify([flight.fly_from.toUpperCase(), flight.fly_to.toUpperCase()]);
    const current = routes.get(key);
    const seen = flight.created_at ?? new Date(0).toISOString();
    const latest = current && current.last_checked_at > seen ? current.last_checked_at : seen;
    if (!current || flight.price < current.min_price) {
      routes.set(key, { non_stop_only: nonStopOnly, fly_from: flight.fly_from, fly_to: flight.fly_to,
        min_price: flight.price, currency: flight.currency, airline: flight.airline,
        departure_at: flight.departure_at, return_at: flight.return_at, nights_in_dest: flight.nights_in_dest,
        deep_link: flight.deep_link, flight_record_id: flight.id!, first_seen_at: seen, last_checked_at: latest });
    } else current.last_checked_at = latest;
  }
  // Keep legacy cached observations for the unrestricted view, including backups with sparse records.
  if (!nonStopOnly) for (const lowest of store.lowestPrices) {
    if (!matchesRoute(lowest, flyFrom, flyTo)) continue;
    const key = JSON.stringify([lowest.fly_from.toUpperCase(), lowest.fly_to.toUpperCase()]);
    const current = routes.get(key);
    if (!current || lowest.min_price < current.min_price) routes.set(key, { ...lowest, non_stop_only: false });
  }
  return [...routes.values()].sort((a, b) => a.min_price - b.min_price);
}

export async function getLatestLowestPrice(flyFrom: string, flyTo: string, nonStopOnly = false): Promise<LowestPriceRecord | null> {
  const store = await readStore();
  return historicalLowest(store, nonStopOnly, flyFrom, flyTo)[0] ?? null;
}

export async function upsertLowestPrice(rec: Omit<LowestPriceRecord, "id" | "first_seen_at" | "last_checked_at">): Promise<{ previousLowest: number | null; isNewLowest: boolean }> {
  return mutateStore(store => {
    const scope = rec.non_stop_only === true;
    const previous = store.lowestPrices.filter(row => matchesRoute(row, rec.fly_from, rec.fly_to) &&
      (!scope || row.non_stop_only === true)).sort((a, b) => a.min_price - b.min_price)[0];
    const result = { previousLowest: previous?.min_price ?? null, isNewLowest: !previous || rec.min_price < previous.min_price };
    const now = nowISO();
    const update = (candidate: typeof rec, nonStopOnly: boolean) => {
      const { id: _id, first_seen_at: _first, last_checked_at: _last, ...fields } = candidate as LowestPriceRecord;
      const existing = store.lowestPrices.find(row => matchesRoute(row, candidate.fly_from, candidate.fly_to) &&
        (row.non_stop_only === true) === nonStopOnly);
      if (!existing) store.lowestPrices.push({ ...fields, non_stop_only: nonStopOnly,
        id: store.nextId.lowestPrices++, first_seen_at: now, last_checked_at: now });
      else if (candidate.min_price < existing.min_price) Object.assign(existing, fields, { non_stop_only: nonStopOnly, last_checked_at: now });
      else existing.last_checked_at = now;
    };
    // A direct fare also belongs to the unrestricted set. Compare first, then update both scopes atomically.
    if (previous) update(previous, false);
    update(rec, false);
    const currentFlight = store.flightRecords.find(flight => flight.id === rec.flight_record_id);
    const confirmed = currentFlight && store.flightRecords.filter(flight =>
      flight.search_run_id === currentFlight.search_run_id && matchesRoute(flight, rec.fly_from, rec.fly_to) &&
      isConfirmedNonStop(flight)).sort((a, b) => a.price - b.price)[0];
    if (confirmed) update({ fly_from: confirmed.fly_from, fly_to: confirmed.fly_to, min_price: confirmed.price,
      currency: confirmed.currency, airline: confirmed.airline, departure_at: confirmed.departure_at,
      return_at: confirmed.return_at, nights_in_dest: confirmed.nights_in_dest, deep_link: confirmed.deep_link,
      flight_record_id: confirmed.id! }, true);
    else if (scope) update(rec, true);
    return result;
  });
}

export async function insertNotificationLog(log: Omit<NotificationLog, "id" | "sent_at">): Promise<number> {
  return mutateStore(store => { const id = store.nextId.notificationLogs++;
    store.notificationLogs.push({ ...log, id, sent_at: nowISO() }); return id; });
}

export async function getRecentNotifications(flightRecordId: number, withinHoursN: number = 12): Promise<number> {
  return (await readStore()).notificationLogs.filter(log => log.flight_record_id === flightRecordId &&
    log.success === 1 && withinHours(log.sent_at, withinHoursN)).length;
}

function notificationHash(flight: FlightRecord, recipient: string): string {
  const identity = [flight.fly_from.trim().toUpperCase(), flight.fly_to.trim().toUpperCase(),
    flight.departure_at.slice(0, 10), flight.return_at.slice(0, 10),
    flight.airline.split(",").map(code => code.trim().toUpperCase()).sort().join(","),
    flight.price, flight.currency.toUpperCase(), recipient.trim().toLowerCase()];
  // Preserve old keys for unconfirmed/connecting records, but never let those claims suppress a verified nonstop fare.
  if (isConfirmedNonStop(flight)) identity.push("confirmed-nonstop");
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** A failed new-low alert must still be retried after the next daily search.
 * The default has no time cutoff; a later success for this itinerary clears it. */
export async function hasFailedNotification(flight: FlightRecord, recipient: string, withinHoursN = Infinity): Promise<boolean> {
  const store = await readStore();
  const identity = notificationHash(flight, recipient);
  const flightsById = new Map(store.flightRecords.map(record => [record.id, record]));
  const logs = store.notificationLogs.filter(log => withinHours(log.sent_at, withinHoursN)).sort((a, b) =>
    Date.parse(b.sent_at) - Date.parse(a.sent_at) || (b.id ?? 0) - (a.id ?? 0));
  for (const log of logs) {
    const record = flightsById.get(log.flight_record_id);
    if (record && notificationHash(record, log.recipient) === identity) return log.success === 0;
  }
  return false;
}

export async function claimNotification(flight: FlightRecord, recipient: string, withinHoursN: number = 12): Promise<string | null> {
  if (!recipient.trim() || !Number.isFinite(withinHoursN) || withinHoursN <= 0) throw new Error("Invalid notification claim settings.");
  const config = requireStorage();
  const hash = notificationHash(flight, recipient);
  const token = randomUUID();
  const seconds = Math.ceil(withinHoursN * 3600);
  if (config.provider === "upstash-redis") {
    const result = await redisCommand(config.redis, ["SET", `${config.redis.key}:notification:${hash}`, token, "NX", "EX", seconds]);
    if (result !== "OK" && result !== null) throw new Error("Persistent storage returned an invalid notification claim.");
    return result === "OK" ? `${hash}:${token}` : null;
  }
  return mutateStore(store => {
    const now = Date.now();
    for (const [key, claim] of Object.entries(store.notificationClaims)) if (claim.expiresAt <= now) delete store.notificationClaims[key];
    if (store.notificationClaims[hash]) return null;
    store.notificationClaims[hash] = { token, expiresAt: now + seconds * 1000 };
    return `${hash}:${token}`;
  });
}

const RELEASE_CLAIM = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export async function releaseNotificationClaim(key: string): Promise<void> {
  const match = /^([a-f0-9]{64}):([a-f0-9-]{36})$/.exec(key);
  if (!match) throw new Error("Invalid notification claim.");
  const [, hash, token] = match;
  const config = requireStorage();
  if (config.provider === "upstash-redis") {
    await redisCommand(config.redis, ["EVAL", RELEASE_CLAIM, 1, `${config.redis.key}:notification:${hash}`, token]);
  } else {
    await mutateStore(store => { if (store.notificationClaims[hash]?.token === token) delete store.notificationClaims[hash]; });
  }
}

export async function listRecentFlights(limit: number = 50, flyFrom?: string, flyTo?: string, nonStopOnly = false): Promise<FlightRecord[]> {
  return (await readStore()).flightRecords.filter(row => matchesRoute(row, flyFrom, flyTo) && (!nonStopOnly || isConfirmedNonStop(row))).sort((a, b) =>
    new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime() || a.price - b.price).slice(0, limit);
}

export async function listCheapestByDay(limit: number = 30, flyFrom?: string, flyTo?: string, nonStopOnly = false): Promise<FlightRecord[]> {
  const map = new Map<string, FlightRecord>();
  for (const flight of (await readStore()).flightRecords) {
    if (!matchesRoute(flight, flyFrom, flyTo) || (nonStopOnly && !isConfirmedNonStop(flight)) || !flight.departure_at) continue;
    const key = flight.departure_at.slice(0, 10);
    const current = map.get(key);
    if (!current || flight.price < current.price) map.set(key, flight);
  }
  return [...map.values()].sort((a, b) => a.price - b.price).slice(0, limit);
}

export async function listSearchRuns(limit: number = 20): Promise<SearchRun[]> {
  return (await readStore()).searchRuns.sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).slice(0, limit);
}

export async function listAllLowestPrices(flyFrom?: string, flyTo?: string, nonStopOnly = false): Promise<LowestPriceRecord[]> {
  const store = await readStore();
  return historicalLowest(store, nonStopOnly, flyFrom, flyTo);
}

export async function getPriceHistory(flyFrom: string, flyTo: string, days: number = 30, nonStopOnly = false): Promise<Array<{ date: string; min_price: number }>> {
  const cutoff = Date.now() - days * 86400000;
  const byDate = new Map<string, number>();
  for (const flight of (await readStore()).flightRecords) {
    if (!matchesRoute(flight, flyFrom, flyTo) || (nonStopOnly && !isConfirmedNonStop(flight)) || new Date(flight.created_at || 0).getTime() < cutoff || !flight.created_at) continue;
    const date = flight.created_at.slice(0, 10);
    const current = byDate.get(date);
    if (current == null || flight.price < current) byDate.set(date, flight.price);
  }
  return [...byDate.entries()].map(([date, min_price]) => ({ date, min_price })).sort((a, b) => a.date.localeCompare(b.date));
}

export async function exportStoreJSON(): Promise<string> {
  return JSON.stringify(await readStore(), null, 2);
}

export async function importStoreJSON(text: string): Promise<boolean> {
  let parsed: DataStore;
  try { parsed = validateStore(JSON.parse(text)); } catch { return false; }
  // Backend errors must propagate: an import is successful only after durable storage acknowledges it.
  await mutateStore(() => undefined, parsed);
  return true;
}
