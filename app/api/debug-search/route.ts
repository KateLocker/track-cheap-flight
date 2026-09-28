import { NextResponse } from "next/server";
import { loadConfig, AppConfig } from "@/lib/config";
import { expandCityToAirports, searchSerpapiRoundTripHard } from "@/lib/google-flights-api";
import { unifySerp } from "@/lib/search-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 10;

export async function GET() {
  const cfg = loadConfig();
  const startedAt = Date.now();
  const searchCfg = cfg.search;

  const log: string[] = [];
  const pushLog = (s: string) => {
    log.push(`${Date.now() - startedAt}ms | ${s}`);
  };

  pushLog(`config: flyFrom=${searchCfg.flyFrom || "empty"} flyTo=${searchCfg.flyTo || "empty"} daysAhead=${searchCfg.searchDaysAhead} nights=${searchCfg.minNights}~${searchCfg.maxNights} selectAirlines=${JSON.stringify(searchCfg.selectAirlines)} mode=${searchCfg.mode || "full"}`);
  pushLog(`keys: rapid=${cfg.rapidapiKey ? `len:${cfg.rapidapiKey.length}` : "no"} serp=${cfg.serpApiKey ? `len:${cfg.serpApiKey.length}` : "no"}`);

  // 1️⃣ 最关键的测试：只跑一次hard search（不带航司筛选 maxCalls=8）
  // hard test实锤：2秒就能有8条结果，保证不超时！
  const fromAirports = expandCityToAirports(searchCfg.flyFrom || "TYO");
  const toAirports = expandCityToAirports(searchCfg.flyTo || "DLC");
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
        singleCallTimeoutMs: 3000, // 每个call最多3秒，8个=24秒但满15条立刻停！
        filterAirlines: false,
        hl: "ja",
        currency: "JPY",
      },
      (msg) => pushLog(`  ${msg}`)
    );
    serpAllAirlines.push(...r.map(x => unifySerp(x as any)));
    pushLog(`HARD SEARCH RESULT: ${serpAllAirlines.length} flights, lowest=${serpAllAirlines[0]?.priceJPY ? "¥" + serpAllAirlines[0].priceJPY : "-"}`);
  } catch (e: any) {
    pushLog(`HARD SEARCH ERROR: ${e?.message || String(e)}`);
  }

  const elapsed = Date.now() - startedAt;
  const sample5 = serpAllAirlines.slice(0, 5).map(f => ({
    priceJPY: f?.priceJPY,
    from: f?.flyFrom, to: f?.flyTo,
    dep: f?.local_departure?.slice(0, 10),
    ret: f?.return_departure?.slice(0, 10),
    nights: f?.nightsInDest,
    airlines: f?.airlines,
    airlineCode: f?.airlineCode,
    source: f?.source,
  }));

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
    log,
  });
}
