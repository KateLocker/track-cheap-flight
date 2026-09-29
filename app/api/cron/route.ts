import { NextResponse } from "next/server";
import { runFullSearch } from "@/lib/search-service";
import { loadConfig } from "@/lib/config";
import { requireCron } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = requireCron(request);
  if (unauthorized) return unauthorized;
  try {
    const result = await runFullSearch(loadConfig(), "light");
    return NextResponse.json({ ...result, ok: result.success && !result.emailError }, {
      status: result.success && !result.emailError ? 200 : 502,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Scheduled search failed." }, { status: 503 });
  }
}
