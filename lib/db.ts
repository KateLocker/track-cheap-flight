import path from "path";
import fs from "fs";

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

interface DataStore {
  searchRuns: SearchRun[];
  flightRecords: FlightRecord[];
  lowestPrices: LowestPriceRecord[];
  notificationLogs: NotificationLog[];
  nextId: {
    searchRuns: number;
    flightRecords: number;
    lowestPrices: number;
    notificationLogs: number;
  };
}

const EMPTY_STORE: DataStore = {
  searchRuns: [],
  flightRecords: [],
  lowestPrices: [],
  notificationLogs: [],
  nextId: {
    searchRuns: 1,
    flightRecords: 1,
    lowestPrices: 1,
    notificationLogs: 1,
  },
};

let storeCache: DataStore | null = null;
let storeCachePath: string | null = null;

function getDataDir(): string {
  const dir =
    (process.env.DATA_DIR as string | undefined) ||
    path.resolve(process.cwd(), "data");
  if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) {
    try {
      fs.mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
    } catch {
      // 只读文件系统下忽略
    }
  }
  return dir;
}

function getDataPath(): string {
  return path.join(getDataDir(), "flights.json");
}

function canWriteFile(p: string): boolean {
  try {
    fs.accessSync(path.dirname(p), fs.constants.W_OK);
    if (fs.existsSync(/*turbopackIgnore: true*/ p))
      fs.accessSync(/*turbopackIgnore: true*/ p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function loadStore(): DataStore {
  const p = getDataPath();
  if (storeCache && storeCachePath === p) return storeCache;
  try {
    if (fs.existsSync(/*turbopackIgnore: true*/ p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as DataStore;
      storeCache = { ...EMPTY_STORE, ...parsed, nextId: { ...EMPTY_STORE.nextId, ...(parsed.nextId || {}) } };
      storeCachePath = p;
      return storeCache;
    }
  } catch {
    // ignore corrupt JSON
  }
  storeCache = JSON.parse(JSON.stringify(EMPTY_STORE)) as DataStore;
  storeCachePath = p;
  return storeCache;
}

let pendingSave: NodeJS.Timeout | null = null;
function saveStore(): void {
  const s = storeCache;
  const p = getDataPath();
  if (!s) return;
  if (!canWriteFile(p)) return;

  if (pendingSave) clearTimeout(pendingSave);
  pendingSave = setTimeout(() => {
    try {
      fs.writeFileSync(p, JSON.stringify(s, null, 0), "utf-8");
    } catch {
      // 忽略只读环境的写入错误
    }
    pendingSave = null;
  }, 20);
}

function nowISO(): string {
  return new Date().toISOString();
}

function withinHours(iso: string, hours: number): boolean {
  return Date.now() - new Date(iso).getTime() <= hours * 3600 * 1000;
}

export function getDb(): { ready: boolean } {
  loadStore();
  return { ready: true };
}

export function insertSearchRun(run: Omit<SearchRun, "id">): number {
  const s = loadStore();
  const id = s.nextId.searchRuns++;
  s.searchRuns.push({ ...run, id });
  saveStore();
  return id;
}

export function insertFlightRecord(rec: Omit<FlightRecord, "id" | "created_at">): number {
  const s = loadStore();
  const id = s.nextId.flightRecords++;
  s.flightRecords.push({ ...rec, id, created_at: nowISO() });
  saveStore();
  return id;
}

export function getLatestLowestPrice(flyFrom: string, flyTo: string): LowestPriceRecord | null {
  const s = loadStore();
  return (
    s.lowestPrices.find(
      (l) => l.fly_from === flyFrom && l.fly_to === flyTo
    ) ?? null
  );
}

export function upsertLowestPrice(rec: Omit<LowestPriceRecord, "id" | "first_seen_at" | "last_checked_at">): void {
  const s = loadStore();
  const existing = s.lowestPrices.find(
    (l) => l.fly_from === rec.fly_from && l.fly_to === rec.fly_to
  );
  const now = nowISO();
  if (!existing) {
    const id = s.nextId.lowestPrices++;
    s.lowestPrices.push({
      ...rec,
      id,
      first_seen_at: now,
      last_checked_at: now,
    });
  } else if (rec.min_price < existing.min_price) {
    existing.min_price = rec.min_price;
    existing.airline = rec.airline;
    existing.departure_at = rec.departure_at;
    existing.return_at = rec.return_at;
    existing.nights_in_dest = rec.nights_in_dest;
    existing.deep_link = rec.deep_link;
    existing.flight_record_id = rec.flight_record_id;
    existing.last_checked_at = now;
  } else {
    existing.last_checked_at = now;
  }
  saveStore();
}

export function insertNotificationLog(log: Omit<NotificationLog, "id" | "sent_at">): number {
  const s = loadStore();
  const id = s.nextId.notificationLogs++;
  s.notificationLogs.push({ ...log, id, sent_at: nowISO() });
  saveStore();
  return id;
}

export function getRecentNotifications(flightRecordId: number, withinHoursN: number = 12): number {
  const s = loadStore();
  let cnt = 0;
  for (const l of s.notificationLogs) {
    if (l.flight_record_id === flightRecordId && l.success === 1 && withinHours(l.sent_at, withinHoursN)) {
      cnt++;
    }
  }
  return cnt;
}

export function listRecentFlights(limit: number = 50): FlightRecord[] {
  const s = loadStore();
  const sorted = [...s.flightRecords].sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    if (tb !== ta) return tb - ta;
    return a.price - b.price;
  });
  return sorted.slice(0, limit);
}

export function listCheapestByDay(limit: number = 30): FlightRecord[] {
  const s = loadStore();
  const map = new Map<string, FlightRecord>();
  for (const f of s.flightRecords) {
    const k = (f.departure_at || "").slice(0, 10);
    if (!k) continue;
    const cur = map.get(k);
    if (!cur || f.price < cur.price) map.set(k, f);
  }
  return [...map.values()].sort((a, b) => a.price - b.price).slice(0, limit);
}

export function listSearchRuns(limit: number = 20): SearchRun[] {
  const s = loadStore();
  return [...s.searchRuns].sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).slice(0, limit);
}

export function listAllLowestPrices(): LowestPriceRecord[] {
  const s = loadStore();
  return [...s.lowestPrices].sort((a, b) => a.min_price - b.min_price);
}

export function getPriceHistory(flyFrom: string, flyTo: string, days: number = 30): Array<{ date: string; min_price: number }> {
  const s = loadStore();
  const cutoff = Date.now() - days * 86400 * 1000;
  const byDate = new Map<string, number>();
  for (const f of s.flightRecords) {
    if (f.fly_from !== flyFrom || f.fly_to !== flyTo) continue;
    const created = new Date(f.created_at || 0).getTime();
    if (created < cutoff) continue;
    const date = (f.created_at || "").slice(0, 10);
    if (!date) continue;
    const cur = byDate.get(date);
    if (cur == null || f.price < cur) byDate.set(date, f.price);
  }
  return [...byDate.entries()]
    .map(([date, min_price]) => ({ date, min_price }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function exportStoreJSON(): string {
  return JSON.stringify(loadStore(), null, 2);
}

export function importStoreJSON(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as DataStore;
    if (!parsed || typeof parsed !== "object") return false;
    storeCache = { ...EMPTY_STORE, ...parsed, nextId: { ...EMPTY_STORE.nextId, ...(parsed.nextId || {}) } };
    storeCachePath = getDataPath();
    saveStore();
    return true;
  } catch {
    return false;
  }
}
