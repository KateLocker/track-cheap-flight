import { NextResponse } from "next/server";
import { runFullSearch } from "@/lib/search-service";
import { loadConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const cfg = loadConfig();
    const result = await runFullSearch(cfg);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
