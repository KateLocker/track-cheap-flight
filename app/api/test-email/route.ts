import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { sendAlertEmail, buildAlertEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { email?: string };
    const cfg = loadConfig();

    if (!cfg.email.enabled || !cfg.email.smtpUser) {
      return NextResponse.json(
        { success: false, error: "メール設定が無効です" },
        { status: 400 }
      );
    }

    const to = body.email || cfg.email.emailTo;
    if (!to) {
      return NextResponse.json(
        { success: false, error: "宛先メールアドレスがありません" },
        { status: 400 }
      );
    }

    const testFlight = {
      id: 0,
      search_run_id: 0,
      price: cfg.email.alertPriceJPY,
      currency: "JPY",
      fly_from: cfg.search.flyFrom,
      fly_to: cfg.search.flyTo,
      airline: "NH",
      airline_name: "全日空 (ANA) - テストメール",
      departure_at: new Date(Date.now() + 14 * 86400 * 1000).toISOString(),
      return_at: new Date(Date.now() + 21 * 86400 * 1000).toISOString(),
      nights_in_dest: 7,
      booking_token: "test",
      deep_link: "https://www.ana.co.jp/",
      raw_data: "",
      created_at: new Date().toISOString(),
    };

    const content = buildAlertEmail({
      flight: testFlight,
      isNewLowest: true,
      previousLowest: cfg.email.alertPriceJPY + 5000,
      alertPrice: cfg.email.alertPriceJPY,
    });

    const { buildTransporter } = await import("@/lib/email");
    const transporter = buildTransporter(cfg.email);
    await transporter.sendMail({
      from: `"Flight Tracker" <${cfg.email.smtpUser}>`,
      to,
      subject: `【TEST】${content.subject}`,
      html: content.html,
      text: content.text,
    });

    return NextResponse.json({ success: true, sentTo: to });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
