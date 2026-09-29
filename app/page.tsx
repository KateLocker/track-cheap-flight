"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type LowestPrice = {
  id: number;
  fly_from: string;
  fly_to: string;
  min_price: number;
  currency: string;
  airline: string;
  departure_at: string;
  return_at: string;
  nights_in_dest: number;
  deep_link: string | null;
  flight_record_id: number;
  first_seen_at: string;
  last_checked_at: string;
};

type FlightRecord = {
  id: number;
  price: number;
  currency: string;
  fly_from: string;
  fly_to: string;
  airline: string;
  airline_name: string;
  departure_at: string;
  return_at: string;
  nights_in_dest: number;
  deep_link: string | null;
  created_at: string;
};

type SearchRun = {
  id: number;
  started_at: string;
  finished_at: string;
  flights_found: number;
  min_price: number | null;
  status: "success" | "failed" | "partial";
  error_message: string | null;
};

type HistoryPoint = { date: string; min_price: number };

type DashboardData = {
  error?: string;
  selectedRoute?: { flyFrom: string; flyTo: string; nonStopOnly: boolean };
  storage?: { provider: string; configured: boolean };
  config: {
    flyFrom: string;
    flyTo: string;
    searchDaysAhead: number;
    minNights: number;
    maxNights: number;
    selectAirlines: string[];
    nonStopOnly: boolean;
    emailEnabled: boolean;
    alertPrice: number;
    cronSchedule: string;
    cronTimezone: string;
    adminConfigured?: boolean;
  };
  latestLowest: LowestPrice | null;
  lowestPrices: LowestPrice[];
  recentFlights: FlightRecord[];
  searchRuns: SearchRun[];
  priceHistory: HistoryPoint[];
};

type SearchResult = {
  success: boolean;
  error?: string;
  flightsFound: number;
  minPrice: number | null;
  isNewLowest: boolean;
  previousLowest: number | null;
  emailSent: boolean;
  emailError?: string;
  status?: "success" | "partial" | "failed";
  warnings?: string[];
  coverage?: {
    sampled: boolean;
    requestsMade: number;
    requestLimit: number;
    departureDates: string[];
    searchedFrom: string | null;
    searchedTo: string | null;
  };
  provider?: "kiwi" | "serpapi" | "amadeus" | "skyscanner" | "mixed" | "none";
};

type SearchParams = {
  flyFrom: string;
  flyTo: string;
  searchDaysAhead: number;
  minNights: number;
  maxNights: number;
  selectAirlines: string;
  nonStopOnly: boolean;
  alertPriceJPY: number;
};

const DEFAULT_SEARCH: SearchParams = {
  flyFrom: "TYO",
  flyTo: "DLC",
  searchDaysAhead: 90,
  minNights: 3,
  maxNights: 14,
  selectAirlines: "NH",
  nonStopOnly: true,
  alertPriceJPY: 70000,
};

const PARAMS_KEY = "track-cheap-flight.search-params.v1";
const ADMIN_KEY = "track-cheap-flight.admin-session";

function loadStoredParams(): SearchParams | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PARAMS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return {
      flyFrom: String(p.flyFrom || DEFAULT_SEARCH.flyFrom).toUpperCase(),
      flyTo: String(p.flyTo || DEFAULT_SEARCH.flyTo).toUpperCase(),
      searchDaysAhead: toIntOr(
        String(p.searchDaysAhead),
        DEFAULT_SEARCH.searchDaysAhead
      ),
      minNights: toIntOr(String(p.minNights), DEFAULT_SEARCH.minNights),
      maxNights: toIntOr(String(p.maxNights), DEFAULT_SEARCH.maxNights),
      selectAirlines: typeof p.selectAirlines === "string" ? p.selectAirlines : DEFAULT_SEARCH.selectAirlines,
      nonStopOnly: typeof p.nonStopOnly === "boolean" ? p.nonStopOnly : DEFAULT_SEARCH.nonStopOnly,
      alertPriceJPY: toIntOr(
        String(p.alertPriceJPY),
        DEFAULT_SEARCH.alertPriceJPY
      ),
    };
  } catch {
    return null;
  }
}

const AIRLINE_OPTIONS = [
  { code: "NH", name: "全日空 ANA" },
  { code: "JL", name: "日本航空 JAL" },
  { code: "CA", name: "中国国航 Air China" },
  { code: "CZ", name: "南方航空 China Southern" },
  { code: "MU", name: "東方航空 China Eastern" },
  { code: "HU", name: "海南航空 Hainan" },
  { code: "9C", name: "春秋航空 Spring" },
  { code: "ZH", name: "深圳航空 Shenzhen" },
  { code: "MF", name: "厦门航空 Xiamen" },
  { code: "", name: "指定なし（全航空会社）" },
];

function fmtJPY(n: number | null | undefined): string {
  if (n == null) return "-";
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtDateTime(iso?: string | null): string {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "-";
  // Flight dates are origin-local calendar dates, not viewer-local instants.
  const calendarDate = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (calendarDate) return `${calendarDate[1]}/${calendarDate[2]}/${calendarDate[3]}`;
  try {
    const d = new Date(iso);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  } catch {
    return iso;
  }
}

function timeAgo(iso?: string | null): string {
  if (!iso) return "-";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  return `${d}日前`;
}

function toIntOr(v: string, fallback: number): number {
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return fallback;
}

export default function HomePage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [params, setParams] = useState<SearchParams>(DEFAULT_SEARCH);
  const [paramsLoaded, setParamsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState("");
  const loadSequence = useRef(0);

  const persistParams = (next: SearchParams) => {
    setParams(next);
    try {
      window.localStorage.setItem(PARAMS_KEY, JSON.stringify(next));
    } catch {}
  };

  const load = useCallback(async (route?: Pick<SearchParams, "flyFrom" | "flyTo" | "nonStopOnly">, initialize = false) => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError(null);
    try {
      const query = route ? `?${new URLSearchParams({ flyFrom: route.flyFrom.trim().toUpperCase(), flyTo: route.flyTo.trim().toUpperCase(), nonStopOnly: String(route.nonStopOnly) })}` : "";
      const response = await fetch(`/api/dashboard${query}`, { cache: "no-store" });
      const json = await response.json() as DashboardData;
      if (sequence !== loadSequence.current) return;
      if (json.config && Array.isArray(json.recentFlights)) {
        setData(json);
        if (initialize) {
          setParams({
            flyFrom: json.config.flyFrom,
            flyTo: json.config.flyTo,
            searchDaysAhead: json.config.searchDaysAhead,
            minNights: json.config.minNights,
            maxNights: json.config.maxNights,
            selectAirlines: json.config.selectAirlines.join(","),
            nonStopOnly: json.config.nonStopOnly,
            alertPriceJPY: json.config.alertPrice,
          });
        }
      } else {
        setData(null);
      }
      if (!response.ok || json.error) throw new Error(json.error || "履歴を読み込めませんでした。");
    } catch (error) {
      if (sequence === loadSequence.current) setLoadError(error instanceof Error ? error.message : "履歴を読み込めませんでした。");
    } finally {
      if (sequence === loadSequence.current) {
        setLoading(false);
        setParamsLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    const stored = loadStoredParams();
    if (stored) setParams(stored);
    try { setAdminToken(window.sessionStorage.getItem(ADMIN_KEY) || ""); } catch {}
    void load(stored ?? undefined, !stored);
    return () => { loadSequence.current += 1; };
  }, [load]);

  const credentials = () => {
    try {
      if (adminToken.trim()) window.sessionStorage.setItem(ADMIN_KEY, adminToken.trim());
      else window.sessionStorage.removeItem(ADMIN_KEY);
    } catch {}
    return { Authorization: `Bearer ${adminToken.trim()}` };
  };

  const runSearch = async () => {
    setSearching(true);
    setSearchResult(null);
    const originalParams = { ...params };
    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...credentials() },
        body: JSON.stringify({ ...originalParams, flyFrom: originalParams.flyFrom.trim().toUpperCase(), flyTo: originalParams.flyTo.trim().toUpperCase() }),
      });
      const json = await response.json() as SearchResult;
      if (!response.ok && json.flightsFound == null) throw new Error(json.error || "検索できませんでした。");
      setSearchResult(json);
      await load(originalParams);
    } catch (error) {
      setSearchResult({
        success: false,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        flightsFound: 0, minPrice: null, isNewLowest: false,
        previousLowest: null, emailSent: false,
      });
    } finally {
      setSearching(false);
    }
  };

  const sendTestEmail = async () => {
    setSendingTest(true);
    setTestMsg(null);
    try {
      const response = await fetch("/api/test-email", { method: "POST", headers: credentials() });
      const json = await response.json() as { success: boolean; error?: string };
      setTestMsg(json.success ? "✅ 設定済みの宛先へテストメールを送信しました。" : `❌ 送信失敗: ${json.error || "不明なエラー"}`);
    } catch (error) {
      setTestMsg(`❌ エラー: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSendingTest(false);
    }
  };

  const uniqueRoutes = useMemo(() => {
    if (!data) return [] as FlightRecord[];
    const seen = new Map<string, FlightRecord>();
    for (const f of data.recentFlights) {
      const k = `${f.fly_from}|${f.fly_to}|${f.departure_at.slice(0, 10)}|${f.return_at.slice(
        0,
        10
      )}|${f.airline}`;
      const cur = seen.get(k);
      if (!cur || f.price < cur.price) seen.set(k, f);
    }
    return Array.from(seen.values())
      .sort((a, b) => a.price - b.price)
      .slice(0, 15);
  }, [data]);

  const displayedRoute = data?.selectedRoute ?? data?.config;
  const displayedFlightScope = (displayedRoute?.nonStopOnly ?? params.nonStopOnly) ? "直行便のみ" : "乗り継ぎ便を含む";

  const historyMax = useMemo(() => {
    if (!data || data.priceHistory.length === 0) return 0;
    return Math.max(...data.priceHistory.map((p) => p.min_price));
  }, [data]);

  const update = (key: keyof SearchParams) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const numeric = ["searchDaysAhead", "minNights", "maxNights", "alertPriceJPY"].includes(key);
    const next = { ...params, [key]: numeric ? Number(e.target.value) : e.target.value };
    persistParams(next);
    setSearchResult(null);
  };

  return (
    <main className="max-w-6xl mx-auto px-4 py-8 md:py-12">
      <header className="mb-10 text-center">
        <div className="inline-block mb-4 text-5xl md:text-6xl">
          ✈️ んぽ
        </div>
        <h1 className="text-3xl md:text-4xl font-black tracking-tight text-primary-800">
          往復航空券の価格トラッカー
        </h1>
        <p className="mt-3 text-primary-700/80">
          日程を分散して定期検索。見つかった低価格をメールでお知らせ 💌
        </p>
      </header>

      {loadError && <div role="alert" className="mb-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">履歴の読み込みに問題があります: {loadError}</div>}
      <details className="npo-card p-4 mb-6" open>
        <summary className="cursor-pointer font-bold text-primary-800">管理アクセス</summary>
        <label htmlFor="admin-token" className="mt-3 block text-sm text-primary-900">管理キー</label>
        <div className="mt-2 flex flex-wrap gap-3 items-center">
          <input id="admin-token" type="password" value={adminToken} autoComplete="off" onChange={e => setAdminToken(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 py-2" placeholder="管理キーを入力" />
          <button type="button" className="text-sm text-primary-800 underline" onClick={() => { setAdminToken(""); try { window.sessionStorage.removeItem(ADMIN_KEY); } catch {} }}>クリア</button>
        </div>
        <p className="mt-2 text-xs text-primary-700">検索・メール送信には管理キーが必要です。操作時にこのタブのセッションだけに保存します。</p>
        {data?.config.adminConfigured === false && <p className="mt-2 text-sm text-rose-700">管理アクセスが未設定です。サイト管理者による設定が必要です。</p>}
      </details>

      <section className="npo-card p-6 md:p-8 mb-8">
        <div className="grid md:grid-cols-2 gap-6 items-start">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="npo-tag bg-amber-100 text-amber-800">
                🏆 {displayedRoute?.flyFrom || "—"} ⇔ {displayedRoute?.flyTo || "—"} の過去最安値
              </span>
              {data?.latestLowest && (
                <span className="npo-tag bg-emerald-100 text-emerald-800">
                  更新: {timeAgo(data.latestLowest.last_checked_at)}
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-primary-700">全航空会社・{displayedFlightScope}の過去の検索結果です。現在の空席・価格は予約先でご確認ください。</p>
            {data?.latestLowest ? (
              <div>
                <div className="text-5xl md:text-6xl font-black text-primary-700 leading-none my-4">
                  {fmtJPY(data.latestLowest.min_price)}
                </div>
                <div className="space-y-1 text-sm md:text-base text-primary-900/80">
                  <div>
                    🛫 {fmtDate(data.latestLowest.departure_at)} 出発 → 🛬{" "}
                    {fmtDate(data.latestLowest.return_at)} 帰国
                  </div>
                  <div>
                    💼 滞在 {data.latestLowest.nights_in_dest} 泊　|　✈️{" "}
                    {data.latestLowest.airline}
                  </div>
                  <div className="text-xs text-primary-700/60 mt-1">
                    初回発見: {fmtDateTime(data.latestLowest.first_seen_at)}
                  </div>
                </div>
                {data.latestLowest.deep_link && (
                  <a
                    href={data.latestLowest.deep_link}
                    target="_blank"
                    rel="noreferrer"
                    className="npo-btn inline-block mt-5 text-base"
                  >
                    👉 予約先で最新の価格を確認
                  </a>
                )}
              </div>
            ) : (
              <div className="text-2xl font-bold text-primary-700/50 my-6">
                {loading ? "履歴を読み込み中..." : loadError ? "履歴を表示できません。上の案内をご確認ください。" : "まだ記録がありません。条件を選んで検索してください。"}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <fieldset disabled={searching || !paramsLoaded} className="grid grid-cols-2 gap-3 text-sm">
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
                <label className="block text-xs text-amber-700 mb-1">
                  🛫 出発（都市・空港コード）
                </label>
                <input
                  type="text"
                  value={params.flyFrom}
                  onChange={update("flyFrom")}
                  className="w-full bg-white rounded-lg px-2 py-1.5 border border-amber-300 focus:outline-none focus:border-orange-400 text-amber-900 font-bold uppercase"
                  placeholder="例 TYO / NRT / HND"
                />
              </div>
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
                <label className="block text-xs text-amber-700 mb-1">
                  🛬 到着（空港コード）
                </label>
                <input
                  type="text"
                  value={params.flyTo}
                  onChange={update("flyTo")}
                  className="w-full bg-white rounded-lg px-2 py-1.5 border border-amber-300 focus:outline-none focus:border-orange-400 text-amber-900 font-bold uppercase"
                  placeholder="例 DLC（大連）"
                />
              </div>
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
                <label className="block text-xs text-amber-700 mb-1">
                  🗓 検索範囲（今日から何日先まで）
                </label>
                <input
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  value={params.searchDaysAhead}
                  onChange={update("searchDaysAhead")}
                  className="w-full bg-white rounded-lg px-2 py-1.5 border border-amber-300 focus:outline-none focus:border-orange-400 text-amber-900 font-bold"
                />
              </div>
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
                <label className="block text-xs text-amber-700 mb-1">
                  💼 泊数（最小〜最大）
                </label>
                <div className="flex gap-1 items-center">
                  <input
                    type="number"
                    min={0}
                    max={90}
                    step={1}
                    value={params.minNights}
                    onChange={update("minNights")}
                    className="w-1/2 bg-white rounded-lg px-2 py-1.5 border border-amber-300 focus:outline-none focus:border-orange-400 text-amber-900 font-bold"
                  />
                  <span className="text-amber-700/80">〜</span>
                  <input
                    type="number"
                    min={0}
                    max={90}
                    step={1}
                    value={params.maxNights}
                    onChange={update("maxNights")}
                    className="w-1/2 bg-white rounded-lg px-2 py-1.5 border border-amber-300 focus:outline-none focus:border-orange-400 text-amber-900 font-bold"
                  />
                </div>
              </div>
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
                <label className="block text-xs text-amber-700 mb-1">
                  ✈️ 航空会社（複数可,「,」区切り）
                </label>
                <select
                  value={params.selectAirlines}
                  onChange={update("selectAirlines")}
                  className="w-full bg-white rounded-lg px-2 py-1.5 border border-amber-300 focus:outline-none focus:border-orange-400 text-amber-900 font-bold"
                >
                  {AIRLINE_OPTIONS.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.code || "指定なし"} {o.name}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={params.selectAirlines}
                  onChange={update("selectAirlines")}
                  className="mt-1 w-full bg-white/80 rounded-lg px-2 py-1 border border-dashed border-amber-300 focus:outline-none focus:border-orange-400 text-xs text-amber-900"
                  placeholder="例 NH,JL,CA"
                />
              </div>
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
                <label className="block text-xs text-amber-700 mb-1">
                  🔔 通知閾値（円以下）
                </label>
                <input
                  type="number"
                  min={1}
                  max={10000000}
                  step={1000}
                  value={params.alertPriceJPY}
                  onChange={update("alertPriceJPY")}
                  className="w-full bg-white rounded-lg px-2 py-1.5 border border-amber-300 focus:outline-none focus:border-orange-400 text-amber-900 font-bold"
                />
              </div>
              <label className="col-span-2 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
                <input
                  type="checkbox"
                  checked={params.nonStopOnly}
                  onChange={event => {
                    const next = { ...params, nonStopOnly: event.target.checked };
                    persistParams(next);
                    setSearchResult(null);
                    setData(null);
                    void load(next);
                  }}
                  className="mt-1 h-4 w-4 shrink-0 accent-orange-500"
                />
                <span className="text-sm text-amber-900">
                  <span className="block font-bold">直行便のみ（乗り継ぎなし）</span>
                  <span className="mt-1 block text-xs text-amber-800">往路・復路の両方が直行便の候補だけを検索・表示します。直行便と確認できない過去の記録も除外します。</span>
                </span>
              </label>
            </fieldset>
            <p className="text-xs text-primary-700">この条件は手動検索用です。毎日の自動検索条件はサイトの設定を使用します。日程は範囲内で抽出するため、全日程の最安値を保証するものではありません。</p>
            <button type="button" disabled={loading || searching || !/^[A-Z]{3}$/i.test(params.flyFrom.trim()) || !/^[A-Z]{3}$/i.test(params.flyTo.trim())} onClick={() => void load(params)} className="text-sm underline text-primary-800">この路線の履歴を表示</button>

            <div className="flex flex-wrap gap-3">
              <button
                onClick={runSearch}
                disabled={searching || !paramsLoaded || !adminToken.trim() || data?.config.adminConfigured === false || data?.storage?.configured === false}
                className="npo-btn flex-1"
              >
                {searching ? "🔍 検索中..." : "🔍 今すぐ検索する"}
              </button>
              <button
                onClick={sendTestEmail}
                disabled={sendingTest || !adminToken.trim() || !data?.config.emailEnabled || data?.config.adminConfigured === false}
                className="npo-btn flex-1 !bg-gradient-to-r !from-pink-400 !to-rose-500 !shadow-rose-300/60"
              >
                {sendingTest ? "💌 送信中..." : "💌 テストメール送信"}
              </button>
            </div>
            {!data?.config.emailEnabled && (
              <p className="text-xs text-rose-600">
                メール通知は未設定です。検索結果はこの画面で確認できます。
              </p>
            )}
            {testMsg && (
              <p className="text-sm bg-white/70 p-3 rounded-xl border border-amber-200">
                {testMsg}
              </p>
            )}
            {searchResult && (
              <div className="bg-white/70 p-4 rounded-xl border border-amber-200 text-sm space-y-1">
                <div className="font-bold text-primary-800 flex items-center justify-between">
                  <span>📊 今回の検索結果</span>
                  {searchResult.provider && (
                    <span className="npo-tag bg-blue-100 text-blue-800">
                      データ元: {searchResult.provider}
                    </span>
                  )}
                </div>
                <div>
                  ステータス:{" "}
                  {searchResult.status === "partial" ? "⚠ 一部の結果を保存しました" : searchResult.success
                    ? "✅ 検索完了"
                    : `⚠ ${searchResult.error || "失敗"}`}
                </div>
                {searchResult.coverage && <div className="text-xs text-primary-700">調査した出発日: {searchResult.coverage.departureDates.length} 日分 / 検索リクエスト: {searchResult.coverage.requestsMade} 回（上限 {searchResult.coverage.requestLimit} 回）。全日程の網羅検索ではありません。</div>}
                {!!searchResult.warnings?.length && <ul className="list-disc pl-5 text-xs text-amber-800">{searchResult.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
                <div>発見件数: {searchResult.flightsFound} 件</div>
                <div>最安値: {fmtJPY(searchResult.minPrice)}</div>
                <div>
                  歴代更新:{" "}
                  {searchResult.isNewLowest ? "🎉 はい！" : "いいえ"}
                  {searchResult.previousLowest != null &&
                    searchResult.isNewLowest &&
                    ` (前回: ${fmtJPY(searchResult.previousLowest)})`}
                </div>
                <div>
                  メール送信:{" "}
                  {searchResult.emailError ? `⚠ ${searchResult.emailError}` : searchResult.emailSent ? "📬 送信済み" : "送信なし（通知条件・重複確認により判定）"}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="npo-card p-6 mb-8">
        <h2 className="text-xl font-bold text-primary-800 mb-4 flex items-center gap-2">
          📈 {displayedRoute?.flyFrom || "—"} ⇔ {displayedRoute?.flyTo || "—"} 30日間の発見価格（全航空会社・{displayedFlightScope}）
        </h2>
        {data && data.priceHistory.length > 0 ? (
          <div>
            <div className="flex items-end gap-1 h-40 md:h-52 w-full">
              {data.priceHistory.map((p) => {
                const h = (p.min_price / historyMax) * 100;
                return (
                  <div
                    key={p.date}
                    className="flex-1 min-w-[4px] rounded-t-md bg-gradient-to-t from-primary-400 to-primary-200 relative group"
                    style={{ height: `${h}%` }}
                    title={`${p.date}: ${fmtJPY(p.min_price)}`}
                  >
                    <div className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 bg-primary-900 text-white text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition">
                      {p.date.slice(5)}: {fmtJPY(p.min_price)}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-xs text-primary-700/60 mt-2">
              <span>{data.priceHistory[0]?.date.slice(5)}</span>
              <span>
                {
                  data.priceHistory[
                    Math.floor(data.priceHistory.length / 2)
                  ]?.date.slice(5)
                }
              </span>
              <span>
                {
                  data.priceHistory[data.priceHistory.length - 1]?.date.slice(5)
                }
              </span>
            </div>
          </div>
        ) : (
          <div className="text-primary-700/50 text-sm py-8 text-center">
            まだ十分なデータがありません。数日間データを集めるとグラフが表示されます。
          </div>
        )}
      </section>

      <section className="npo-card p-6 mb-8">
        <h2 className="text-xl font-bold text-primary-800 mb-4 flex items-center gap-2">
          🔥 最近の格安往復（{displayedFlightScope}・上位15件）
        </h2>
        <p className="text-xs text-primary-700/70 mb-3">
          表示中の路線で過去に見つかった候補です。現在の検索条件とは異なる記録も含みます。日付のみの表示は検索対象日を示します。便の時刻・空席・運航会社は予約先でご確認ください。
        </p>
        {uniqueRoutes.length > 0 ? (
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-primary-700/70 border-b border-amber-200">
                  <th className="px-3 py-2 font-semibold">価格</th>
                  <th className="px-3 py-2 font-semibold">行き</th>
                  <th className="px-3 py-2 font-semibold">帰り</th>
                  <th className="px-3 py-2 font-semibold">泊</th>
                  <th className="px-3 py-2 font-semibold">航空</th>
                  <th className="px-3 py-2 font-semibold">発見</th>
                  <th className="px-3 py-2 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {uniqueRoutes.map((f, i) => (
                  <tr
                    key={f.id}
                    className={`border-b border-amber-100 ${
                      i === 0 ? "bg-amber-100/50 font-bold" : ""
                    }`}
                  >
                    <td className="px-3 py-3 text-primary-800 whitespace-nowrap">
                      {i === 0 && <span className="mr-1">👑</span>}
                      {fmtJPY(f.price)}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {fmtDate(f.departure_at)}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {fmtDate(f.return_at)}
                    </td>
                    <td className="px-3 py-3">{f.nights_in_dest}</td>
                    <td className="px-3 py-3">
                      {!f.airline || f.airline === "ALL" || f.airline === "?"
                        ? "航空会社未確認"
                        : `${f.airline_name || f.airline} (${f.airline})`}
                    </td>
                    <td className="px-3 py-3 text-xs text-primary-700/60 whitespace-nowrap">
                      {timeAgo(f.created_at)}
                    </td>
                    <td className="px-3 py-3">
                      {f.deep_link && (
                        <a
                          href={f.deep_link}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs font-bold text-primary-600 hover:underline"
                        >
                          予約 →
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-primary-700/50 text-sm py-8 text-center">
            データなし
          </div>
        )}
      </section>

      <section className="npo-card p-6 mb-8">
        <h2 className="text-xl font-bold text-primary-800 mb-4 flex items-center gap-2">
          ⏱ 検索実行履歴（全路線・全条件・直近20回）
        </h2>
        {data?.searchRuns && data.searchRuns.length > 0 ? (
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-primary-700/70 border-b border-amber-200">
                  <th className="px-3 py-2 font-semibold">実行時刻</th>
                  <th className="px-3 py-2 font-semibold">ステータス</th>
                  <th className="px-3 py-2 font-semibold">発見件数</th>
                  <th className="px-3 py-2 font-semibold">最安値</th>
                  <th className="px-3 py-2 font-semibold">備考</th>
                </tr>
              </thead>
              <tbody>
                {data.searchRuns.map((r) => (
                  <tr key={r.id} className="border-b border-amber-100">
                    <td className="px-3 py-2 whitespace-nowrap">
                      {fmtDateTime(r.started_at)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`npo-tag ${
                          r.status === "success"
                            ? "bg-emerald-100 text-emerald-800"
                            : r.status === "partial"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-rose-100 text-rose-800"
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">{r.flights_found}</td>
                    <td className="px-3 py-2 font-bold">{fmtJPY(r.min_price)}</td>
                    <td className="px-3 py-2 text-xs text-rose-600 max-w-[260px] truncate">
                      {r.error_message || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-primary-700/50 text-sm py-8 text-center">
            まだ一度も検索実行されていません
          </div>
        )}
        <p className="mt-4 text-xs text-primary-700/60">
          🕑 Cron設定:{" "}
          <code className="bg-amber-100 px-2 py-0.5 rounded">
            {data?.config.cronSchedule}
          </code>
          （タイムゾーン: {data?.config.cronTimezone || "—"}）{data?.config.cronTimezone === "UTC" && " · 0 0 * * * は日本時間の毎日9時"}
        </p>
      </section>

      <footer className="text-center text-xs text-primary-700/50 py-6">
        Made with 💛 for んぽちゃむ　|　データは SerpAPI (Google
        Flights) ほか設定済みの検索サービスより取得
      </footer>
    </main>
  );
}
