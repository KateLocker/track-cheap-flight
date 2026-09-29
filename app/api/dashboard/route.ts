import { NextResponse } from "next/server";
import { listRecentFlights, listAllLowestPrices, listSearchRuns, getPriceHistory, getLatestLowestPrice, getStorageStatus } from "@/lib/db";
import { loadConfig } from "@/lib/config";
import { isAdminConfigured } from "@/lib/auth";
import { airportCode, InputError } from "@/lib/api-validation";
import { safeBookingLink } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cfg = loadConfig();
  const storage = getStorageStatus();
  const config = {
    flyFrom: cfg.search.flyFrom, flyTo: cfg.search.flyTo,
    searchDaysAhead: cfg.search.searchDaysAhead, minNights: cfg.search.minNights, maxNights: cfg.search.maxNights,
    adults: cfg.search.adults, selectAirlines: cfg.search.selectAirlines, nonStopOnly: cfg.search.nonStopOnly,
    emailEnabled: cfg.email.enabled, alertPrice: cfg.email.alertPriceJPY,
    cronSchedule: process.env.VERCEL === "1" ? "0 0 * * *" : cfg.cron.schedule,
    cronTimezone: process.env.VERCEL === "1" ? "UTC" : cfg.cron.timezone,
    adminConfigured: isAdminConfigured(),
  };
  const empty = { config, storage, latestLowest: null, lowestPrices: [], recentFlights: [], searchRuns: [], priceHistory: [] };
  try {
    const url = new URL(request.url);
    const from = airportCode(url.searchParams.get("flyFrom") ?? cfg.search.flyFrom, "flyFrom");
    const to = airportCode(url.searchParams.get("flyTo") ?? cfg.search.flyTo, "flyTo");
    const nonStopValues = url.searchParams.getAll("nonStopOnly");
    if (nonStopValues.length > 1 || (nonStopValues.length === 1 && !["true", "false"].includes(nonStopValues[0]))) {
      throw new InputError("nonStopOnly must be true or false.");
    }
    const nonStopOnly = nonStopValues.length ? nonStopValues[0] === "true" : cfg.search.nonStopOnly;
    const [latestLowest, lowestPrices, recentFlights, searchRuns, priceHistory] = await Promise.all([
      getLatestLowestPrice(from, to, nonStopOnly), listAllLowestPrices(from, to, nonStopOnly), listRecentFlights(100, from, to, nonStopOnly),
      listSearchRuns(20), getPriceHistory(from, to, 30, nonStopOnly),
    ]);
    return NextResponse.json({
      config, storage, selectedRoute: { flyFrom: from, flyTo: to, nonStopOnly },
      latestLowest: latestLowest ? { ...latestLowest, deep_link: safeBookingLink(latestLowest.deep_link) } : null,
      lowestPrices: lowestPrices.map(record => ({ ...record, deep_link: safeBookingLink(record.deep_link) })),
      recentFlights: recentFlights.map(({ booking_token: _booking, raw_data: _raw, ...record }) => ({ ...record, deep_link: safeBookingLink(record.deep_link) })),
      searchRuns: searchRuns.map(run => ({ ...run, error_message: run.error_message ? "検索の一部または全部が完了しませんでした。管理者は検索結果を確認してください。" : null })),
      priceHistory,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof InputError ? error.message : storage.configured
      ? "Flight history storage is unavailable. Check the storage service configuration and connectivity."
      : "Persistent storage is not configured. Configure UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.";
    return NextResponse.json({ ...empty, error: message }, { status: error instanceof InputError ? 400 : 503, headers: { "Cache-Control": "no-store" } });
  }
}
