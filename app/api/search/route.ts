import { NextResponse } from "next/server";
import { runFullSearch } from "@/lib/search-service";
import { loadConfig, SearchConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseListCsv(s?: string | null): string[] | undefined {
  if (!s) return undefined;
  return s
    .split(/[,，\s]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
}

export async function POST(request: Request) {
  try {
    const cfg = loadConfig();
    let body: Partial<{
      flyFrom: string;
      flyTo: string;
      searchDaysAhead: number | string;
      minNights: number | string;
      maxNights: number | string;
      adults: number | string;
      selectAirlines: string | string[];
      maxPriceJPY: number | string;
      alertPriceJPY: number | string;
      mode: "light" | "full";
    }> = {};
    try {
      body = (await request.json()) ?? {};
    } catch {}

    const overrideSearch: Partial<SearchConfig> = {};
    if (body.flyFrom)
      overrideSearch.flyFrom = String(body.flyFrom).toUpperCase();
    if (body.flyTo)
      overrideSearch.flyTo = String(body.flyTo).toUpperCase();
    if (body.searchDaysAhead != null) {
      const v = parseInt(String(body.searchDaysAhead), 10);
      if (Number.isFinite(v) && v > 0) overrideSearch.searchDaysAhead = v;
    }
    if (body.minNights != null) {
      const v = parseInt(String(body.minNights), 10);
      if (Number.isFinite(v) && v >= 0) overrideSearch.minNights = v;
    }
    if (body.maxNights != null) {
      const v = parseInt(String(body.maxNights), 10);
      if (Number.isFinite(v) && v >= 0) overrideSearch.maxNights = v;
    }
    if (body.adults != null) {
      const v = parseInt(String(body.adults), 10);
      if (Number.isFinite(v) && v > 0) overrideSearch.adults = v;
    }
    if (body.selectAirlines != null) {
      const list = Array.isArray(body.selectAirlines)
        ? body.selectAirlines
        : parseListCsv(body.selectAirlines);
      if (list) overrideSearch.selectAirlines = list;
    }
    if (body.maxPriceJPY != null) {
      const v = parseInt(String(body.maxPriceJPY), 10);
      if (Number.isFinite(v) && v > 0) overrideSearch.maxPriceJPY = v;
    }
    const overrideAlert =
      body.alertPriceJPY != null
        ? parseInt(String(body.alertPriceJPY), 10)
        : undefined;

    const mergedCfg = {
      ...cfg,
      search: { ...cfg.search, ...overrideSearch },
      email: {
        ...cfg.email,
        alertPriceJPY:
          overrideAlert && Number.isFinite(overrideAlert)
            ? overrideAlert
            : cfg.email.alertPriceJPY,
      },
    };

    const mode = body.mode === "light" ? "light" : "full";
    const result = await runFullSearch(mergedCfg, mode);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
