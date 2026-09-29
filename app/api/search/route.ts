import { NextResponse } from "next/server";
import { runFullSearch } from "@/lib/search-service";
import { loadConfig } from "@/lib/config";
import { requireAdmin, limitAdminAction } from "@/lib/auth";
import { InputError, readJSONObject, validateSearchRequest } from "@/lib/api-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;
  try {
    const config = validateSearchRequest(await readJSONObject(request), loadConfig());
    const limited = limitAdminAction("search", 6);
    if (limited) return limited;
    const result = await runFullSearch(config, config.search.mode);
    return NextResponse.json(result, { status: result.success ? 200 : 502, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Search failed." },
      { status: error instanceof InputError ? 400 : 503 }
    );
  }
}
