import { requireAdmin, limitAdminAction } from "@/lib/auth";
import { airportCode } from "@/lib/api-validation";
import { NextResponse } from "next/server";
import axios from "axios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SERP_API = "https://serpapi.com/search.json";

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

function expandCity(code: string): string[] {
  const map: Record<string, string[]> = {
    TYO: ["TYO", "NRT", "HND"],
    SPK: ["SPK", "CTS"],
    OSA: ["OSA", "KIX", "ITM"],
    SEL: ["SEL", "ICN", "GMP"],
    SHA: ["SHA", "PVG"],
    NYC: ["NYC", "JFK", "LGA", "EWR"],
    CHI: ["CHI", "ORD", "MDW"],
    LAX: ["LAX", "LGB", "BUR"],
    SFO: ["SFO", "OAK", "SJC"],
    PAR: ["PAR", "CDG", "ORY"],
    LON: ["LON", "LHR", "LGW", "STN"],
    WAS: ["WAS", "IAD", "DCA"],
  };
  const u = code.toUpperCase();
  return map[u] || [u];
}

export async function GET(req: Request) {
  const unauthorized = requireAdmin(req);
  if (unauthorized) return unauthorized;
  const url = new URL(req.url);
  if (url.searchParams.has("api_key")) return NextResponse.json({ ok: false, error: "API keys must be configured on the server, not sent in URLs." }, { status: 400 });
  const apiKey = process.env.SERPAPI_KEY || "";
  let flyFrom: string;
  let flyTo: string;
  const airline = (url.searchParams.get("airline") || "").toUpperCase();
  try {
    flyFrom = airportCode(url.searchParams.get("flyFrom") || "TYO", "flyFrom");
    flyTo = airportCode(url.searchParams.get("flyTo") || "DLC", "flyTo");
    if (airline && !/^[A-Z0-9]{2}$/.test(airline)) throw new Error("airline must be one two-character airline code.");
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Invalid diagnostic parameters." }, { status: 400 });
  }
  const limited = limitAdminAction("diagnostics", 2);
  if (limited) return limited;

  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "SERPAPI_KEY not configured" }, { status: 503 });
  }

  const froms = expandCity(flyFrom);
  const tos = expandCity(flyTo);

  const today = new Date();
  const candidateDates: Date[] = [];
  for (let daysOut = 14; daysOut <= 84; daysOut += 7) {
    candidateDates.push(addDays(today, daysOut));
  }

  type CaseKey = {
    name: string;
    from: string;
    to: string;
    date: Date;
    roundTrip: boolean;
    airline?: string;
  };

  const cases: CaseKey[] = [];
  for (const f of froms) {
    for (const t of tos) {
      for (let i = 0; i < Math.min(3, candidateDates.length); i++) {
        const d = candidateDates[i];
        cases.push({ name: `${f}→${t} ${fmt(d)} 单程`, from: f, to: t, date: d, roundTrip: false });
        if (airline) {
          cases.push({ name: `${f}→${t} ${fmt(d)} 单程[${airline}]`, from: f, to: t, date: d, roundTrip: false, airline });
        }
        if (cases.length < 24) {
          cases.push({ name: `${f}→${t} ${fmt(d)} +7泊 往返`, from: f, to: t, date: d, roundTrip: true });
        }
      }
    }
  }

  const results: Array<{
    name: string;
    ok: boolean;
    count?: number;
    samplePrice?: number;
    sampleAirlines?: string[];
    error?: string;
  }> = [];

  let successCount = 0;
  let hitSample: { from: string; to: string; date: string; price: number; airlines?: string[] } | null = null;

  const deadline = Date.now() + 45_000;
  for (let i = 0; i < Math.min(cases.length, 8) && Date.now() < deadline; i++) {
    const c = cases[i];
    const outboundDate = fmt(c.date);
    const returnDate = fmt(addDays(c.date, 7));
    try {
      const params: Record<string, unknown> = {
        engine: "google_flights",
        api_key: apiKey,
        hl: "ja",
        gl: "jp",
        currency: "JPY",
        departure_id: c.from,
        arrival_id: c.to,
        outbound_date: outboundDate,
        type: c.roundTrip ? "1" : "2",
        adults: "1",
      };
      if (c.roundTrip) params.return_date = returnDate;
      if (c.airline) params.include_airlines = c.airline;

      const resp = await axios.get(SERP_API, { params, timeout: Math.min(8_000, Math.max(1, deadline - Date.now())) });
      const data = resp.data as {
        best_flights?: unknown;
        other_flights?: unknown;
        error?: unknown;
      };
      const bestArr = Array.isArray(data.best_flights) ? data.best_flights as Array<{ price?: number; flights?: unknown }> : [];
      const otherArr = Array.isArray(data.other_flights) ? data.other_flights as Array<{ price?: number; flights?: unknown }> : [];
      const list = [...bestArr, ...otherArr];
      const count = list.length;
      const first = list[0] as { price?: number; flights?: unknown } | undefined;
      const firstPrice = first?.price;
      const firstAirlines = new Set<string>();
      const flightsArr = Array.isArray(first?.flights) ? first?.flights as Array<unknown> : [];
      for (const leg of flightsArr) {
        const legArr = Array.isArray(leg) ? leg as Array<{ airline_code?: string }> : [];
        for (const seg of legArr) {
          if (seg?.airline_code) firstAirlines.add(seg.airline_code);
        }
      }
      const errStr = typeof data.error === "string" ? data.error : (data.error && typeof data.error === "object" ? JSON.stringify(data.error).slice(0, 300) : undefined);
      if (!errStr && count > 0) {
        successCount++;
        if (!hitSample && firstPrice) {
          hitSample = {
            from: c.from, to: c.to, date: outboundDate,
            price: firstPrice,
            airlines: firstAirlines.size ? Array.from(firstAirlines) : undefined,
          };
        }
      }
      results.push({
        name: c.name,
        ok: !errStr,
        count,
        samplePrice: firstPrice,
        sampleAirlines: firstAirlines.size ? Array.from(firstAirlines) : undefined,
        error: errStr,
      });
      if (successCount >= 4) break;
    } catch (e) {
      const err =
        e instanceof Error
          ? e.message +
            (axios.isAxiosError(e)
              ? ` | status=${e.response?.status} data=${JSON.stringify(e.response?.data || "").slice(0, 300)}`
              : "")
          : String(e);
      results.push({ name: c.name, ok: false, error: err });
    }
  }

  const ok = results.some(result => result.ok);
  return NextResponse.json({
    ok,
    ts: new Date().toISOString(),
    fromExpanded: froms,
    toExpanded: tos,
    firstHitSample: hitSample,
    hits: successCount,
    totalTried: results.length,
    results,
  }, { status: ok ? 200 : 502, headers: { "Cache-Control": "no-store" } });
}
