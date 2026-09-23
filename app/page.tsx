"use client";

import { useEffect, useMemo, useState } from "react";

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
  config: {
    flyFrom: string;
    flyTo: string;
    searchDaysAhead: number;
    minNights: number;
    maxNights: number;
    selectAirlines: string[];
    emailEnabled: boolean;
    alertPrice: number;
    cronSchedule: string;
    cronTimezone: string;
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
};

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
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "-";
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

export default function HomePage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/dashboard", { cache: "no-store" });
      const json = (await r.json()) as DashboardData;
      setData(json);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const runSearch = async () => {
    setSearching(true);
    setSearchResult(null);
    try {
      const r = await fetch("/api/search", { method: "POST" });
      const json = (await r.json()) as SearchResult;
      setSearchResult(json);
      await load();
    } finally {
      setSearching(false);
    }
  };

  const sendTestEmail = async () => {
    setSendingTest(true);
    setTestMsg(null);
    try {
      const r = await fetch("/api/test-email", { method: "POST" });
      const json = (await r.json()) as { success: boolean; error?: string; sentTo?: string };
      if (json.success) {
        setTestMsg(`✅ テストメール送信完了 → ${json.sentTo}`);
      } else {
        setTestMsg(`❌ 送信失敗: ${json.error || "不明なエラー"}`);
      }
    } catch (e) {
      setTestMsg(`❌ エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSendingTest(false);
    }
  };

  const uniqueRoutes = useMemo(() => {
    if (!data) return [] as FlightRecord[];
    const seen = new Map<string, FlightRecord>();
    for (const f of data.recentFlights) {
      const k = `${f.departure_at.slice(0, 10)}|${f.return_at.slice(0, 10)}|${f.airline}`;
      const cur = seen.get(k);
      if (!cur || f.price < cur.price) seen.set(k, f);
    }
    return Array.from(seen.values()).sort((a, b) => a.price - b.price).slice(0, 15);
  }, [data]);

  const historyMax = useMemo(() => {
    if (!data || data.priceHistory.length === 0) return 0;
    return Math.max(...data.priceHistory.map((p) => p.min_price));
  }, [data]);

  return (
    <main className="max-w-6xl mx-auto px-4 py-8 md:py-12">
      <header className="mb-10 text-center">
        <div className="inline-block mb-4 text-5xl md:text-6xl">✈️ んぽ</div>
        <h1 className="text-3xl md:text-4xl font-black tracking-tight text-primary-800">
          ANA 東京 ⇔ 大连 最安値トラッカー
        </h1>
        <p className="mt-3 text-primary-700/80">
          自動で毎日数回検索 → 過去最安値 or 設定価格以下になったらメールでお知らせ 💌
        </p>
      </header>

      <section className="npo-card p-6 md:p-8 mb-8">
        <div className="grid md:grid-cols-2 gap-6 items-start">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="npo-tag bg-amber-100 text-amber-800">🏆 現在の歴代最安値</span>
              {data?.latestLowest && (
                <span className="npo-tag bg-emerald-100 text-emerald-800">
                  更新: {timeAgo(data.latestLowest.last_checked_at)}
                </span>
              )}
            </div>
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
                    👉 ANAで予約する
                  </a>
                )}
              </div>
            ) : (
              <div className="text-2xl font-bold text-primary-700/50 my-6">
                まだデータがありません。下のボタンで今すぐ検索！
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
                <div className="text-xs text-amber-700 mb-1">🗓 検索範囲</div>
                <div className="font-bold text-amber-900">
                  今日から {data?.config.searchDaysAhead ?? 90} 日間
                </div>
              </div>
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
                <div className="text-xs text-amber-700 mb-1">💼 泊数</div>
                <div className="font-bold text-amber-900">
                  {data?.config.minNights ?? 3} ~ {data?.config.maxNights ?? 14} 泊
                </div>
              </div>
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
                <div className="text-xs text-amber-700 mb-1">✈️ 航空会社</div>
                <div className="font-bold text-amber-900">
                  {data?.config.selectAirlines.join(",") || "指定なし"}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
                <div className="text-xs text-amber-700 mb-1">🔔 通知閾値</div>
                <div className="font-bold text-amber-900">
                  {fmtJPY(data?.config.alertPrice)} 以下
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                onClick={runSearch}
                disabled={searching}
                className="npo-btn flex-1"
              >
                {searching ? "🔍 検索中..." : "🔍 今すぐ検索する"}
              </button>
              <button
                onClick={sendTestEmail}
                disabled={sendingTest || !data?.config.emailEnabled}
                className="npo-btn flex-1 !bg-gradient-to-r !from-pink-400 !to-rose-500 !shadow-rose-300/60"
              >
                {sendingTest ? "💌 送信中..." : "💌 テストメール送信"}
              </button>
            </div>
            {!data?.config.emailEnabled && (
              <p className="text-xs text-rose-600">
                ⚠ .env で EMAIL_ENABLED=true にし、SMTP設定をするとメール通知が有効になります
              </p>
            )}
            {testMsg && (
              <p className="text-sm bg-white/70 p-3 rounded-xl border border-amber-200">
                {testMsg}
              </p>
            )}
            {searchResult && (
              <div className="bg-white/70 p-4 rounded-xl border border-amber-200 text-sm space-y-1">
                <div className="font-bold text-primary-800">📊 今回の検索結果</div>
                <div>ステータス: {searchResult.success ? "✅ 成功" : `⚠ ${searchResult.error || "失敗"}`}</div>
                <div>発見件数: {searchResult.flightsFound} 件</div>
                <div>最安値: {fmtJPY(searchResult.minPrice)}</div>
                <div>
                  歴代更新: {searchResult.isNewLowest ? "🎉 はい！" : "いいえ"}
                  {searchResult.previousLowest != null &&
                    searchResult.isNewLowest &&
                    ` (前回: ${fmtJPY(searchResult.previousLowest)})`}
                </div>
                <div>メール送信: {searchResult.emailSent ? "📬 送信済み" : "スキップ"}</div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="npo-card p-6 mb-8">
        <h2 className="text-xl font-bold text-primary-800 mb-4 flex items-center gap-2">
          📈 30日間の価格推移
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
                {(
                  data.priceHistory[Math.floor(data.priceHistory.length / 2)]
                )?.date.slice(5)}
              </span>
              <span>
                {data.priceHistory[data.priceHistory.length - 1]?.date.slice(5)}
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
          🔥 最近の格安往復（上位15件）
        </h2>
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
                    <td className="px-3 py-3 whitespace-nowrap">{fmtDate(f.departure_at)}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{fmtDate(f.return_at)}</td>
                    <td className="px-3 py-3">{f.nights_in_dest}</td>
                    <td className="px-3 py-3">{f.airline}</td>
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
          ⏱ 検索実行履歴（直近20回）
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
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDateTime(r.started_at)}</td>
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
          🕑 Cron設定: <code className="bg-amber-100 px-2 py-0.5 rounded">{data?.config.cronSchedule}</code>
          （タイムゾーン: {data?.config.cronTimezone}） | Vercel へデプロイ時は vercel.json の schedule も参照
        </p>
      </section>

      <footer className="text-center text-xs text-primary-700/50 py-6">
        Made with 💛 for んぽちゃむ　|　データは Kiwi.com (Tequila API) より取得
      </footer>
    </main>
  );
}
