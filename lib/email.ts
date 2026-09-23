import nodemailer from "nodemailer";
import type { EmailConfig } from "./config";
import type { FlightRecord } from "./db";
import { format } from "date-fns";
import { ja } from "date-fns/locale/ja";

export function buildTransporter(cfg: EmailConfig) {
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    auth: {
      user: cfg.smtpUser,
      pass: cfg.smtpPass,
    },
  });
}

export function formatJPY(n: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(n);
}

export function formatDateTimeJST(iso: string): string {
  try {
    return format(new Date(iso), "yyyy/MM/dd HH:mm", { locale: ja });
  } catch {
    return iso;
  }
}

export function buildAlertEmail(params: {
  flight: FlightRecord;
  isNewLowest: boolean;
  previousLowest?: number | null;
  alertPrice: number;
}) {
  const { flight, isNewLowest, previousLowest, alertPrice } = params;

  const subject = isNewLowest
    ? `【ANA最安値更新！】${formatJPY(flight.price)} 東京→大连 往復`
    : `【ANA机票提醒】${formatJPY(flight.price)} 低于阈值 ${formatJPY(alertPrice)}`;

  const compareLine =
    isNewLowest && previousLowest != null
      ? `<p style="color:#b91c1c;font-size:18px;font-weight:bold;">💸 历史最低更新！之前最低：${formatJPY(previousLowest)} → 现在：${formatJPY(flight.price)}（省 ${formatJPY(previousLowest - flight.price)}）</p>`
      : `<p style="color:#065f46;font-size:18px;font-weight:bold;">✅ 价格低于设置阈值 ${formatJPY(alertPrice)}</p>`;

  const html = `
    <div style="max-width:600px;margin:0 auto;font-family:'Hiragino Sans','Noto Sans JP',sans-serif;color:#111;">
      <div style="background:linear-gradient(90deg,#f19532,#ee7a11);color:#fff;padding:20px 24px;border-radius:12px 12px 0 0;">
        <h1 style="margin:0;font-size:22px;">${subject}</h1>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;">
        ${compareLine}
        <hr style="border:none;border-top:1px dashed #ddd;margin:20px 0;">
        <table cellpadding="8" cellspacing="0" style="width:100%;font-size:15px;">
          <tr><td style="width:30%;color:#666;">航空会社</td><td><strong>${flight.airline_name || flight.airline}</strong></td></tr>
          <tr><td style="color:#666;">路線</td><td>${flight.fly_from} → ${flight.fly_to}（往復）</td></tr>
          <tr><td style="color:#666;">行き出発</td><td>${formatDateTimeJST(flight.departure_at)}</td></tr>
          <tr><td style="color:#666;">帰り出発</td><td>${formatDateTimeJST(flight.return_at)}</td></tr>
          <tr><td style="color:#666;">現地滞在</td><td>${flight.nights_in_dest} 泊</td></tr>
          <tr><td style="color:#666;">金額</td><td style="font-size:22px;color:#b91c1c;font-weight:bold;">${formatJPY(flight.price)}</td></tr>
        </table>
        <div style="margin-top:24px;text-align:center;">
          <a href="${flight.deep_link || "#"}"
             style="display:inline-block;padding:14px 40px;background:#ee7a11;color:#fff;text-decoration:none;border-radius:999px;font-weight:bold;font-size:16px;">
            👉 今すぐ予約する（ANA）
          </a>
        </div>
        <p style="margin-top:20px;color:#888;font-size:12px;text-align:center;">
          ※ 本メールはシステム自動送信です。価格は変動する場合があります。
        </p>
      </div>
    </div>
  `;

  const text = [
    subject,
    "",
    `航空会社: ${flight.airline_name || flight.airline}`,
    `路線: ${flight.fly_from} → ${flight.fly_to}（往復）`,
    `行き: ${formatDateTimeJST(flight.departure_at)}`,
    `帰り: ${formatDateTimeJST(flight.return_at)}`,
    `滞在: ${flight.nights_in_dest} 泊`,
    `価格: ${formatJPY(flight.price)}`,
    "",
    `予約リンク: ${flight.deep_link || "-"}`,
  ].join("\n");

  return { subject, html, text };
}

export async function sendAlertEmail(
  cfg: EmailConfig,
  flight: FlightRecord,
  isNewLowest: boolean,
  previousLowest: number | null
): Promise<void> {
  if (!cfg.enabled) return;
  if (!cfg.smtpHost || !cfg.smtpUser || !cfg.smtpPass || !cfg.emailTo) {
    throw new Error("Email configuration is incomplete");
  }
  const transporter = buildTransporter(cfg);
  const content = buildAlertEmail({
    flight,
    isNewLowest,
    previousLowest,
    alertPrice: cfg.alertPriceJPY,
  });

  await transporter.sendMail({
    from: `"Flight Tracker" <${cfg.smtpUser}>`,
    to: cfg.emailTo,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });
}
