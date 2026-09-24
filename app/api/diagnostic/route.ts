import { NextResponse } from "next/server";
import axios from "axios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const url = new URL(req.url);
  const apiKey = url.searchParams.get("api_key") || process.env.SERPAPI_KEY || "";
  const flyFrom = (url.searchParams.get("flyFrom") || "TYO").toUpperCase();
  const flyTo = (url.searchParams.get("flyTo") || "DLC").toUpperCase();
  const airline = url.searchParams.get("airline") || "";

  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "SERPAPI_KEY not configured" }, { status: 400 });
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

  for (let i = 0; i < Math.min(cases.length, 18); i++) {
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
      if (c.airline) (params as any).airline_codes = c.airline;

      const resp = await axios.get(SERP_API, { params, timeout: 60_000 });
      const data = resp.data as {
        best_flights?: Array<{ price?: number; flights?: Array<Array<{ airline_code?: string }>> }>;
        other_flights?: Array<{ price?: number; flights?: Array<Array<{ airline_code?: string }>> }>;
        error?: string;
      };
      const list = [...(data.best_flights || []), ...(data.other_flights || [])];
      const count = list.length;
      const first = list[0];
      const firstPrice = first?.price;
      const firstAirlines = new Set<string>();
      for (const leg of first?.flights || []) {
        for (const seg of leg) {
          if (seg.airline_code) firstAirlines.add(seg.airline_code);
        }
      }
      if (!data.error && count > 0) {
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
        ok: !data.error,
        count,
        samplePrice: firstPrice,
        sampleAirlines: firstAirlines.size ? Array.from(firstAirlines) : undefined,
        error: data.error,
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

  return NextResponse.json({
    ok: true,
    ts: new Date().toISOString(),
    fromExpanded: froms,
    toExpanded: tos,
    firstHitSample: hitSample,
    hits: successCount,
    totalTried: results.length,
    results,
  });
}
