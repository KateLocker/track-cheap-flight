import { addDays, format } from "date-fns";

interface BudgetState {
  requestsMade: number;
  successfulRequests: number;
  issues: Set<string>;
  departureDates: Set<string>;
}

/** Shared across providers, including airport lookup, authentication and return-leg requests. */
export class SearchBudget {
  readonly deadline: number;
  private used = 0;
  private readonly state: BudgetState;
  constructor(
    readonly requestLimit = 16,
    durationMs = 20_000,
    readonly label = "Search",
    state?: BudgetState,
    private readonly globalLimit = requestLimit,
  ) {
    this.deadline = Date.now() + durationMs;
    this.state = state ?? { requestsMade: 0, successfulRequests: 0, issues: new Set(), departureDates: new Set() };
  }
  get remainingMs() { return Math.max(0, this.deadline - Date.now()); }
  get remainingRequests() { return Math.max(0, Math.min(this.requestLimit - this.used, this.globalLimit - this.state.requestsMade)); }
  get canRequest() { return this.remainingMs > 0 && this.remainingRequests > 0; }
  get requestsMade() { return this.state.requestsMade; }
  get successfulRequests() { return this.state.successfulRequests; }
  get warnings() { return Array.from(this.state.issues); }
  get departureDates() { return Array.from(this.state.departureDates).sort(); }
  scope(label: string, calls: number, durationMs: number) {
    return new SearchBudget(Math.min(calls, this.remainingRequests), Math.min(durationMs, this.remainingMs), label, this.state, this.globalLimit);
  }
  warn(message: string) { this.state.issues.add(`${this.label}: ${message}`); }
  recordDate(date: string) { this.state.departureDates.add(date); }
  checkTime() {
    if (this.remainingMs <= 0) this.warn("搜索时间已用完，已保留收到的结果。");
    return this.canRequest;
  }
  async request<T>(operation: (options: { signal: AbortSignal; timeout: number }) => Promise<T>, maxTimeout = 8_000): Promise<T> {
    if (!this.checkTime()) throw new Error("Search budget exhausted");
    this.used++;
    this.state.requestsMade++;
    const timeout = Math.max(1, Math.min(maxTimeout, this.remainingMs));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const result = await operation({ signal: controller.signal, timeout });
      this.state.successfulRequests++;
      return result;
    } catch (error) {
      const e = error as { code?: string; response?: { status?: number } };
      this.warn(controller.signal.aborted || e.code === "ECONNABORTED" || e.code === "ERR_CANCELED"
        ? "请求超时并已取消，搜索范围可能不完整。"
        : `请求失败${e.response?.status ? `（HTTP ${e.response.status}）` : ""}。`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Sample both ends of the requested range; never silently extend or clamp it. */
export function sampleDepartureDates(searchDaysAhead: number, count: number, now = new Date()): Date[] {
  const days = Math.max(1, Math.floor(searchDaysAhead));
  const n = Math.max(1, Math.min(days, Math.floor(count)));
  const offsets = n === 1 ? [1] : Array.from({ length: n }, (_, i) => 1 + Math.round(i * (days - 1) / (n - 1)));
  // Visit both endpoints first so interrupted searches do not only cover the near term.
  const ordered = n <= 2 ? offsets : [offsets[0], offsets[n - 1], ...offsets.slice(1, -1)];
  return ordered.map(offset => addDays(now, offset));
}

export function sampleNights(min: number, max: number): number[] {
  return Array.from(new Set([min, max, Math.round((min + max) / 2), 7, 10].filter(n => n >= min && n <= max)));
}

export function matchesAirlines(codes: string[], selected: string[]): boolean {
  if (!selected.length) return true;
  const allowed = new Set(selected.map(s => s.trim().toUpperCase()));
  return codes.length > 0 && codes.every(code => allowed.has(code.trim().toUpperCase()));
}

export function calendarNights(departure: string, returning: string): number {
  // These are local calendar dates; do not round time-of-day differences into nights.
  const date = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
  return Math.round((date(returning) - date(departure)) / 86_400_000);
}

export function dateText(date: Date): string { return format(date, "yyyy-MM-dd"); }
