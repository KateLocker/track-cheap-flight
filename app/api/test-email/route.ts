import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { sendAlertEmail } from "@/lib/email";
import { requireAdmin, limitAdminAction } from "@/lib/auth";
import { InputError, readJSONObject } from "@/lib/api-validation";
import type { FlightRecord } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await readJSONObject(request);
    if (Object.keys(body).length > 0) throw new InputError("Test email uses only the configured recipient; request fields are not accepted.");
    const cfg = loadConfig();
    if (!cfg.email.enabled) return NextResponse.json({ success: false, error: "Email notifications are disabled." }, { status: 503 });
    if (!cfg.email.smtpHost || !cfg.email.smtpUser || !cfg.email.smtpPass || !cfg.email.emailTo) {
      return NextResponse.json({ success: false, error: "SMTP and recipient configuration must be completed first." }, { status: 503 });
    }
    const limited = limitAdminAction("test-email", 1);
    if (limited) return limited;
    const testFlight: FlightRecord = {
      id: 0, search_run_id: 0, price: cfg.email.alertPriceJPY, currency: "JPY",
      fly_from: cfg.search.flyFrom, fly_to: cfg.search.flyTo,
      airline: cfg.search.selectAirlines.join(","), airline_name: "テスト通知（実際の航空券ではありません）",
      departure_at: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
      return_at: new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10),
      nights_in_dest: 7, booking_token: "", deep_link: "", raw_data: "",
      created_at: new Date().toISOString(),
    };
    await sendAlertEmail(cfg.email, testFlight, false, null, { subjectPrefix: "【TEST】 " });
    return NextResponse.json({ success: true, sentTo: cfg.email.emailTo }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Test email delivery failed." }, { status: error instanceof InputError ? 400 : 502 });
  }
}
