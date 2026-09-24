import { NextResponse } from "next/server";
import axios from "axios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERP_API = "https://serpapi.com/search.json";
const DEFAULT_FROM = "TYO";
const DEFAULT_TO = "DLC";

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmt(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const apiKey =
    url.searchParams.get("api_key") ||
    process.env.SERPAPI_KEY ||
    "";
  const flyFrom =
    (url.searchParams.get("flyFrom") || DEFAULT_FROM).toUpperCase();
  const flyTo = (url.searchParams.get("flyTo") || DEFAULT_TO).toUpperCase();
  const airline = url.searchParams.get("airline") || "";
  const daysOut = parseInt(url.searchParams.get("days_out") || "30", 10);

  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "SERPAPI_KEY not configured" },
      { status: 400 }
    );
  }

  const tests: Array<{ name: string; departDate: string; params: Record<string, unknown> }> = [];
  const baseDate = addDays(new Date(), Math.max(7, Math.min(30, daysOut)));
  const variants: Array<{ from: string; to: string; airline?: string }> = [
    { from: flyFrom, to: flyTo, airline: airline || undefined },
    { from: flyFrom, to: flyTo, airline: undefined },
  ];
  if (flyFrom === "TYO") {
    variants.push({ from: "NRT", to: flyTo });
    variants.push({ from: "HND", to: flyTo });
  }
  for (const v of variants) {
    tests.push({
      name: `${v.from}→${v.to}${v.airline ? "(" + v.airline + ")" : ""} @ ${fmt(baseDate)}`,
      departDate: fmt(baseDate),
      params: {
        engine: "google_flights",
        api_key: apiKey,
        hl: "ja",
        gl: "jp",
        currency: "JPY",
        departure_id: v.from,
        arrival_id: v.to,
        outbound_date: fmt(baseDate),
        return_date: fmt(addDays(baseDate, 7)),
        type: "1",
        adults: "1",
        ...(v.airline ? { include_airlines: v.airline } : {}),
      },
    });
    break;
  }

  const results: Array<{ name: string; ok: boolean; count?: number; samplePrice?: number; error?: string; raw?: unknown }> = [];
  for (const t of tests) {
    try {
      const resp = await axios.get(SERP_API, {
        params: t.params,
        timeout: 60_000,
      });
      const data = resp.data as {
        best_flights?: Array<{ flights?: unknown[]; price?: number }>;
        other_flights?: Array<{ flights?: unknown[]; price?: number }>;
        error?: string;
      };
      const flights = data.best_flights || data.other_flights || [];
      const count = flights.length;
      const firstPrice = data.best_flights?.[0]?.price;
      results.push({
        name: t.name,
        ok: !data.error,
        count,
        samplePrice: firstPrice,
        error: data.error,
        raw:
          count === 0
            ? {
                keys: Object.keys(data).slice(0, 20),
                search_metadata: (data as any).search_metadata,
              }
            : undefined,
      });
      if (count > 0) break;
    } catch (e) {
      const err =
        e instanceof Error
          ? e.message +
            (axios.isAxiosError(e)
              ? ` | status=${e.response?.status} data=${JSON.stringify(e.response?.data || "").slice(0, 400)}`
              : "")
          : String(e);
      results.push({ name: t.name, ok: false, error: err });
    }
  }

  return NextResponse.json({
    ok: true,
    ts: new Date().toISOString(),
    results,
    tip: results.every((r) => r.count === 0)
      ? "该航线在Google Flights上目前可能无直飞结果，建议改为搜索东京→上海(PVG)/北京(PEK)或其他航点确认API正常后，再用多航点混合搜索。"
      : undefined,
  });
}
