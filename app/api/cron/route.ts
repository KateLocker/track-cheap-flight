import { NextResponse } from "next/server";
import { runFullSearch } from "@/lib/search-service";
import { loadConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  const crontabSecret = process.env.CRON_SECRET;
  if (crontabSecret && crontabSecret.length > 0) {
    if (authHeader !== `Bearer ${crontabSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (process.env.VERCEL === "1") {
    const host = req.headers.get("host") || "";
    if (!host.includes("vercel")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const cfg = loadConfig();
  const result = await runFullSearch(cfg, "light");

  return NextResponse.json({
    ok: result.success,
    flights: result.flightsFound,
    minPrice: result.minPrice,
    newLowest: result.isNewLowest,
    emailSent: result.emailSent,
    error: result.error,
  });
}
