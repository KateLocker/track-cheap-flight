import { requireAdmin, limitAdminAction } from "@/lib/auth";
import { NextResponse } from "next/server";
import { loadConfig, AppConfig } from "@/lib/config";
import { expandCityToAirports, searchSerpapiRoundTripHard } from "@/lib/google-flights-api";
import { unifySerp } from "@/lib/search-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// 递归收集所有含"airline"或"code"或"flight"的key
function collectAirlineKeys(obj: any, prefix = "", out: Record<string, any> = {}, maxDepth = 4): Record<string, any> {
  if (!obj || maxDepth < 0) return out;
  if (typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 5); i++) {
      collectAirlineKeys(obj[i], `${prefix}[${i}]`, out, maxDepth - 1);
    }
    return out;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const fullKey = prefix ? `${prefix}.${k}` : k;
    const low = k.toLowerCase();
    if (
      low.includes("airline") ||
      low.includes("flight_number") ||
      low === "code" ||
      low === "iata" ||
      low === "name" ||
      low.includes("carrier")
    ) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) {
        out[fullKey] = v;
      } else if (Array.isArray(v) && v.length > 0 && (typeof v[0] === "string" || typeof v[0] === "number")) {
        out[fullKey] = v;
      } else if (typeof v === "object" && !Array.isArray(v)) {
        out[fullKey] = Object.keys(v).slice(0, 20);
        collectAirlineKeys(v, fullKey, out, maxDepth - 1);
      }
    }
    if (typeof v === "object" && !Array.isArray(v) && ["flights", "segments", "route", "airlines"].includes(k)) {
      collectAirlineKeys(v, fullKey, out, maxDepth - 1);
    } else if (typeof v === "object" && maxDepth > 2) {
      collectAirlineKeys(v, fullKey, out, maxDepth - 1);
    }
  }
  return out;
}

export async function GET(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;
  const limited = limitAdminAction("diagnostics", 2);
  if (limited) return limited;
  const cfg = loadConfig();
  if (!cfg.serpApiKey) return NextResponse.json({ ok: false, error: "SERPAPI_KEY is not configured." }, { status: 503 });
  const startedAt = Date.now();
  const searchCfg = cfg.search;

  const log: string[] = [];
  const pushLog = (s: string) => {
    log.push(`${Date.now() - startedAt}ms | ${s}`);
  };

  pushLog(`config: flyFrom=${searchCfg.flyFrom || "empty"} flyTo=${searchCfg.flyTo || "empty"} daysAhead=${searchCfg.searchDaysAhead} nights=${searchCfg.minNights}~${searchCfg.maxNights} selectAirlines=${JSON.stringify(searchCfg.selectAirlines)} mode=${searchCfg.mode || "full"}`);
  pushLog(`keys: rapid=${cfg.rapidapiKey ? `len:${cfg.rapidapiKey.length}` : "no"} serp=${cfg.serpApiKey ? `len:${cfg.serpApiKey.length}` : "no"}`);

  const fromAirports = expandCityToAirports(searchCfg.flyFrom || "TYO");
  const toAirports = expandCityToAirports(searchCfg.flyTo || "DLC");
  const rawResults: any[] = [];
  const serpAllAirlines: any[] = [];
  try {
    pushLog(`call searchSerpapiRoundTripHard — no airline filter, maxCalls=8, fromAirports=${fromAirports.join(",")} toAirports=${toAirports.join(",")}`);
    const r = await searchSerpapiRoundTripHard(
      {
        api_key: cfg.serpApiKey || "",
        fromAirports,
        toAirports,
        searchDaysAhead: searchCfg.searchDaysAhead || 90,
        minNights: searchCfg.minNights || 3,
        maxNights: searchCfg.maxNights || 14,
        maxCalls: 8,
        stopWhenFoundN: 15,
        singleCallTimeoutMs: 3000,
        filterAirlines: false,
        nonStopOnly: searchCfg.nonStopOnly,
        hl: "ja",
        currency: "JPY",
      },
      (msg) => pushLog(`  ${msg}`)
    );
    rawResults.push(...r.slice(0, 5));
    serpAllAirlines.push(...r.map(x => unifySerp(x as any)));
    pushLog(`HARD SEARCH RESULT: ${serpAllAirlines.length} flights, lowest=${serpAllAirlines[0]?.priceJPY ? "¥" + serpAllAirlines[0].priceJPY : "-"}`);
  } catch (e: any) {
    pushLog(`HARD SEARCH ERROR: ${e?.message || String(e)}`);
  }

  const elapsed = Date.now() - startedAt;
  const sample5 = serpAllAirlines.slice(0, 5).map((f, index) => ({
    priceJPY: f?.priceJPY,
    from: f?.flyFrom, to: f?.flyTo,
    dep: f?.departureAt?.slice(0, 10),
    ret: f?.returnAt?.slice(0, 10),
    nights: f?.nightsInDest,
    airlines: rawResults[index]?.airlines,
    rawAirlineFields: collectAirlineKeys(rawResults[index]?.flights, "flights"),
    airlineCode: f?.airlineCode,
    source: f?.source,
  }));

  // 🔍 原始dump：第0条RoundTripSearchResult的raw字段 / 所有airline相关键
  const zeroRaw = rawResults[0] || null;
  const zeroAllAirlineKeys = zeroRaw ? collectAirlineKeys(zeroRaw, "res") : {};
  const zeroFlightsDump: any[] = [];
  if (zeroRaw && Array.isArray(zeroRaw.raw)) {
    for (let i = 0; i < Math.min(zeroRaw.raw.length, 4); i++) {
      const fl = zeroRaw.raw[i];
      const keys = Object.keys(fl || {});
      const segs = fl?.segments || fl;
      const segKeys = Array.isArray(segs) && segs.length > 0 ? Object.keys(segs[0] || {}) : [];
      zeroFlightsDump.push({ idx: i, topKeys: keys.slice(0, 30), seg0Keys: segKeys.slice(0, 30), allAirlineFields: collectAirlineKeys(fl, `fl[${i}]`) });
    }
  }

  return NextResponse.json({
    ok: true,
    elapsedMs: elapsed,
    config: {
      flyFrom: searchCfg.flyFrom || "empty",
      flyTo: searchCfg.flyTo || "empty",
      daysAhead: searchCfg.searchDaysAhead,
      minNights: searchCfg.minNights,
      maxNights: searchCfg.maxNights,
      selectAirlines: searchCfg.selectAirlines,
      flyFromExpanded: fromAirports,
      flyToExpanded: toAirports,
    },
    hardSearch: {
      count: serpAllAirlines.length,
      minPrice: serpAllAirlines[0]?.priceJPY || null,
      sample5,
    },
    // 🔴 新增调试部分！把第0条航班所有和airline/flight有关的字段全吐出来！
    _debug: {
      zero: zeroRaw ? {
        id: zeroRaw.id,
        price: zeroRaw.price,
        airlines: zeroRaw.airlines,
        flyFrom: zeroRaw.flyFrom,
        local_departure: zeroRaw.local_departure,
        nightsInDest: zeroRaw.nightsInDest,
      } : null,
      zeroAllAirlineKeys,
      zeroFlightsDump,
    },
    log,
  });
}
