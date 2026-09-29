import nodemailer from "nodemailer";
import type { EmailConfig } from "./config";
import type { FlightRecord } from "./db";

export function buildTransporter(cfg: EmailConfig) {
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    requireTLS: !cfg.smtpSecure,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 15_000,
    auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
  });
}

export function formatJPY(n: number): string {
  return new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(n);
}

// Flight providers represent departure times in the airport's local calendar.
// Keep the supplied date/time rather than applying the server's timezone.
export function formatDateTimeJST(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
  if (!match) return "日付未確認";
  return `${match[1]}/${match[2]}/${match[3]}${match[4] ? ` ${match[4]}:${match[5]}` : ""}`;
}

export function escapeHTML(value: unknown): string {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function safeBookingLink(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : "";
  } catch { return ""; }
}

export function buildAlertEmail(params: {
  flight: FlightRecord;
  isNewLowest: boolean;
  previousLowest?: number | null;
  alertPrice: number;
}) {
  const { flight, isNewLowest, previousLowest, alertPrice } = params;
  const route = `${flight.fly_from} → ${flight.fly_to}`;
  const airline = flight.airline_name || flight.airline || "航空会社未確認";
  const subject = `【${isNewLowest ? "最安値更新" : "航空券価格通知"}】${formatJPY(flight.price)} ${route} 往復`.replace(/[\r\n]/g, " ");
  const comparison = isNewLowest
    ? previousLowest != null
      ? `観測した最安値を更新しました。前回 ${formatJPY(previousLowest)} → 今回 ${formatJPY(flight.price)}`
      : `今回初めて観測した最安値は ${formatJPY(flight.price)} です。`
    : flight.price <= alertPrice
      ? `設定した通知価格 ${formatJPY(alertPrice)} 以下の航空券が見つかりました。`
      : "以前に観測した低価格の通知を再送しています。最新の価格は予約先でご確認ください。";
  const bookingLink = safeBookingLink(flight.deep_link);
  const departure = formatDateTimeJST(flight.departure_at);
  const returning = formatDateTimeJST(flight.return_at);
  const rows = [
    ["航空会社", airline], ["路線", `${route}（往復）`],
    ["行き出発（現地時間）", departure], ["帰り出発（現地時間）", returning],
    ["現地滞在", `${flight.nights_in_dest} 泊`], ["金額", formatJPY(flight.price)],
  ];
  const html = `
    <div style="max-width:600px;margin:0 auto;font-family:sans-serif;color:#111;">
      <div style="background:#ee7a11;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0;">
        <h1 style="margin:0;font-size:22px;">${escapeHTML(subject)}</h1>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #eee;border-radius:0 0 12px 12px;">
        <p>${escapeHTML(comparison)}</p>
        <table cellpadding="8" cellspacing="0" style="width:100%;font-size:15px;">
          ${rows.map(([label, value]) => `<tr><td style="color:#666;">${escapeHTML(label)}</td><td>${escapeHTML(value)}</td></tr>`).join("")}
        </table>
        ${bookingLink ? `<p style="text-align:center;"><a href="${escapeHTML(bookingLink)}" style="display:inline-block;padding:14px 32px;background:#ee7a11;color:#fff;border-radius:24px;">予約サイトで確認する</a></p>` : "<p>予約リンクは取得できませんでした。航空会社または予約サイトで確認してください。</p>"}
        <p style="color:#888;font-size:12px;">自動通知です。価格は変動します。検索した日程の一部を比較した結果です。</p>
      </div>
    </div>`;
  const text = [subject, "", comparison, ...rows.map(([label, value]) => `${label}: ${value}`), "", `予約リンク: ${bookingLink || "未取得"}`].join("\n");
  return { subject, html, text };
}

export async function sendAlertEmail(
  cfg: EmailConfig,
  flight: FlightRecord,
  isNewLowest: boolean,
  previousLowest: number | null,
  options: { subjectPrefix?: string } = {}
): Promise<void> {
  if (!cfg.enabled) return;
  if (!cfg.smtpHost || !cfg.smtpUser || !cfg.smtpPass || !cfg.emailTo) throw new Error("Email configuration is incomplete.");
  const transporter = buildTransporter(cfg);
  const content = buildAlertEmail({ flight, isNewLowest, previousLowest, alertPrice: cfg.alertPriceJPY });
  try {
    await transporter.sendMail({
      from: { name: "Flight Tracker", address: cfg.smtpUser },
      to: cfg.emailTo,
      subject: `${options.subjectPrefix || ""}${content.subject}`,
      html: content.html,
      text: content.text,
    });
  } finally { transporter.close(); }
}
