import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export function isAdminConfigured(): boolean {
  return (process.env.ADMIN_TOKEN?.trim().length ?? 0) >= 32;
}

function authorize(request: Request, name: "ADMIN_TOKEN" | "CRON_SECRET", minimumLength: number): NextResponse | null {
  const secret = process.env[name]?.trim();
  if (!secret || secret.length < minimumLength) {
    return NextResponse.json(
      { success: false, error: `${name} must be configured with at least ${minimumLength} characters before this endpoint can be used.` },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return NextResponse.json(
      { success: false, error: "Endpoint authorization is required." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  return null;
}

export function requireAdmin(request: Request): NextResponse | null {
  return authorize(request, "ADMIN_TOKEN", 32);
}

export function requireCron(request: Request): NextResponse | null {
  return authorize(request, "CRON_SECRET", 32);
}

// This per-process counter limits repeated clicks; authentication is the access
// boundary. It is not a distributed quota or concurrency lock.
const windows = new Map<string, { count: number; resetAt: number }>();
export function limitAdminAction(action: string, maximum: number, intervalMs = 60_000): NextResponse | null {
  const now = Date.now();
  const entry = windows.get(action);
  if (!entry || entry.resetAt <= now) {
    windows.set(action, { count: 1, resetAt: now + intervalMs });
    return null;
  }
  if (entry.count >= maximum) {
    return NextResponse.json(
      { success: false, error: "Too many requests in this server process. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((entry.resetAt - now) / 1000)), "Cache-Control": "no-store" } }
    );
  }
  entry.count++;
  return null;
}
