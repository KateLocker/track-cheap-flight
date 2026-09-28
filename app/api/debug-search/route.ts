import { NextResponse } from "next/server";
import { loadConfig, AppConfig } from "@/lib/config";
import { expandCityToAirports, searchSerpapiRoundTripHard } from "@/lib/google-flights-api";
import { unifySerp } from "@/lib/search-service";
import { skySearch, unifySky } from "@/lib/skyscanner-api";
import * as searchService from "@/lib/search-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET() {
  const cfg = loadConfig();
  const startedAt = Date.now();
  const searchCfg = cfg.search;

  const log: string[] = [];
  const pushLog = (s: string) => {
    log.push(`${Date.now() - startedAt}ms | ${s}`);
  };

  pushLog(`config loaded: flyFrom=${searchCfg.flyFrom || "<empty>"} flyTo=${searchCfg.flyTo || "<empty>"} daysAhead=${searchCfg.searchDaysAhead} nights=${searchCfg.minNights}~${searchCfg.maxNights} selectAirlines=${JSON.stringify(searchCfg.selectAirlines)} maxPrice=${searchCfg.maxPriceJPY} mode=${searchCfg.mode || "full"}`);
  pushLog(`keys: rapid=${cfg.rapidapiKey ? `len:${cfg.rapidapiKey.length}` : "no"} serp=${cfg.serpApiKey ? `len:${cfg.serpApiKey.length}` : "no"}`);

  // 1: 直接跑serp hard test（不带航司筛选 先拿数据）
  const serpAllAirlines: any[] = [];
  const fromAirports = expandCityToAirports(searchCfg.flyFrom || "TYO");
  const toAirports = expandCityToAirports(searchCfg.flyTo || "DLC");
  try {
    pushLog(`call searchSerpapiRoundTripHard - no airline filter, fromAirports=${fromAirports.join(",")} toAirports=${toAirports.join(",")} maxCalls=12`);
    const r = await searchSerpapiRoundTripHard(
      {
        api_key: cfg.serpApiKey || "",
        fromAirports,
        toAirports,
        searchDaysAhead: searchCfg.searchDaysAhead || 90,
        minNights: searchCfg.minNights || 3,
        maxNights: searchCfg.maxNights || 14,
        maxCalls: 12,
        stopWhenFoundN: 20,
        singleCallTimeoutMs: 4500,
        filterAirlines: false, // 不筛！先拿全部！
        hl: "ja",
        currency: "JPY",
      },
      (msg) => pushLog(`  ${msg}`)
    );
    serpAllAirlines.push(...r.map(x => unifySerp(x as any)));
    pushLog(`serp all airlines got: ${serpAllAirlines.length} flights, lowest=${serpAllAirlines[0]?.priceJPY ? "¥" + serpAllAirlines[0].priceJPY : "-"}`);
  } catch (e: any) {
    pushLog(`serp all airlines ERROR: ${e?.message || String(e)}`);
  }

  // 2: serp带航司筛选（如果用户selectAirlines配置了）
  const serpFilteredAirlines: any[] = [];
  if (searchCfg.selectAirlines && searchCfg.selectAirlines.length > 0) {
    try {
      pushLog(`call searchSerpapiRoundTripHard - FILTERED only ${searchCfg.selectAirlines.join(",")} maxCalls=12`);
      const r = await searchSerpapiRoundTripHard(
        {
          api_key: cfg.serpApiKey || "",
          fromAirports,
          toAirports,
          searchDaysAhead: searchCfg.searchDaysAhead || 90,
          minNights: searchCfg.minNights || 3,
          maxNights: searchCfg.maxNights || 14,
          maxCalls: 12,
          stopWhenFoundN: 20,
          singleCallTimeoutMs: 4500,
          airlineCodes: searchCfg.selectAirlines,
          filterAirlines: true,
          hl: "ja",
          currency: "JPY",
        },
        (msg) => pushLog(`  ${msg}`)
      );
      serpFilteredAirlines.push(...r.map(x => unifySerp(x as any)));
      pushLog(`serp filtered (${searchCfg.selectAirlines.join(",")}) got: ${serpFilteredAirlines.length} flights, lowest=${serpFilteredAirlines[0]?.priceJPY ? "¥" + serpFilteredAirlines[0].priceJPY : "-"}`);
    } catch (e: any) {
      pushLog(`serp filtered ERROR: ${e?.message || String(e)}`);
    }
  }

  // 3: 直接调用 runFullSearch
  let fullResult: any = null;
  try {
    pushLog(`call runFullSearch mode=full (limit 7500ms)...`);
    fullResult = await searchService.runFullSearch(cfg, "full");
    pushLog(`runFullSearch done: status=${fullResult?.status} flightsFound=${fullResult?.flights?.length || fullResult?.flightsFound || "?"} lowest=${fullResult?.flights?.[0]?.priceJPY || fullResult?.minPrice || "-"} providers=${fullResult?.providers || fullResult?.providerSet?.join(",")} errors=${(fullResult?.errors || []).join(" | ").slice(0, 200) || "none"}`);
  } catch (e: any) {
    pushLog(`runFullSearch ERROR: ${e?.message || String(e)}`);
  }

  const elapsed = Date.now() - startedAt;
  const sample = (arr: any[], n = 5) => arr.slice(0, n).map(f => ({
    priceJPY: f?.priceJPY,
    from: f?.flyFrom, to: f?.flyTo,
    dep: f?.local_departure?.slice(0, 10),
    ret: f?.return_departure?.slice(0, 10),
    nights: f?.nightsInDest,
    airlines: f?.airlines || f?.airlineCodes,
    source: f?.source,
  }));

  return NextResponse.json({
    ok: true,
    elapsedMs: elapsed,
    config: {
      flyFrom: searchCfg.flyFrom || "<empty>",
      flyTo: searchCfg.flyTo || "<empty>",
      daysAhead: searchCfg.searchDaysAhead,
      minNights: searchCfg.minNights,
      maxNights: searchCfg.maxNights,
      selectAirlines: searchCfg.selectAirlines,
      maxPriceJPY: searchCfg.maxPriceJPY,
      adults: searchCfg.adults,
      mode: searchCfg.mode,
      flyFromExpanded: fromAirports,
      flyToExpanded: toAirports,
    },
    serpAllAirlines: {
      count: serpAllAirlines.length,
      sample5: sample(serpAllAirlines, 5),
    },
    serpFilteredAirlines: searchCfg.selectAirlines && searchCfg.selectAirlines.length > 0 ? {
      count: serpFilteredAirlines.length,
      sample5: sample(serpFilteredAirlines, 5),
    } : null,
    runFullSearch: fullResult ? {
      status: fullResult.status,
      flightsFound: fullResult.flights?.length ?? fullResult.flightsFound ?? 0,
      minPrice: fullResult.minPrice || null,
      providers: fullResult.providers || Array.from(fullResult.providerSet || []),
      errors: fullResult.errors || [],
      flightSample5: sample(fullResult.flights || []),
    } : null,
    log,
  });
}
