import { NextResponse } from "next/server";
import {
  listRecentFlights,
  listAllLowestPrices,
  listSearchRuns,
  getPriceHistory,
  getLatestLowestPrice,
} from "@/lib/db";
import { loadConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = loadConfig();
  return NextResponse.json({
    config: {
      flyFrom: cfg.search.flyFrom,
      flyTo: cfg.search.flyTo,
      searchDaysAhead: cfg.search.searchDaysAhead,
      minNights: cfg.search.minNights,
      maxNights: cfg.search.maxNights,
      selectAirlines: cfg.search.selectAirlines,
      emailEnabled: cfg.email.enabled,
      alertPrice: cfg.email.alertPriceJPY,
      cronSchedule: cfg.cron.schedule,
      cronTimezone: cfg.cron.timezone,
    },
    latestLowest: getLatestLowestPrice(cfg.search.flyFrom, cfg.search.flyTo),
    lowestPrices: listAllLowestPrices(),
    recentFlights: listRecentFlights(100),
    searchRuns: listSearchRuns(20),
    priceHistory: getPriceHistory(cfg.search.flyFrom, cfg.search.flyTo, 30),
  });
}
