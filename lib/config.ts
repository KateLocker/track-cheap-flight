export interface SearchConfig {
  flyFrom: string;
  flyTo: string;
  searchDaysAhead: number;
  minNights: number;
  maxNights: number;
  adults: number;
  selectAirlines: string[];
  maxPriceJPY: number | null;
}

export interface EmailConfig {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  emailTo: string;
  alertPriceJPY: number;
}

export interface CronConfig {
  schedule: string;
  timezone: string;
}

export interface AppConfig {
  kiwiApiKey: string;
  serpApiKey: string;
  amadeusClientId: string;
  amadeusClientSecret: string;
  search: SearchConfig;
  email: EmailConfig;
  cron: CronConfig;
}

function parseList(val: string | undefined, fallback: string[] = []): string[] {
  if (!val) return fallback;
  return val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIntSafe(val: string | undefined, fallback: number | null = null): number | null {
  if (!val) return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

export function loadConfig(): AppConfig {
  const env = process.env;

  return {
    kiwiApiKey: env.KIWI_API_KEY ?? "",
    serpApiKey: env.SERPAPI_KEY ?? "",
    amadeusClientId: env.AMADEUS_CLIENT_ID ?? "",
    amadeusClientSecret: env.AMADEUS_CLIENT_SECRET ?? "",
    search: {
      flyFrom: env.FLY_FROM ?? "TYO",
      flyTo: env.FLY_TO ?? "DLC",
      searchDaysAhead: parseIntSafe(env.SEARCH_DAYS_AHEAD, 90) ?? 90,
      minNights: parseIntSafe(env.MIN_NIGHTS, 3) ?? 3,
      maxNights: parseIntSafe(env.MAX_NIGHTS, 14) ?? 14,
      adults: parseIntSafe(env.ADULTS, 1) ?? 1,
      selectAirlines: parseList(env.SELECT_AIRLINES, ["NH"]),
      maxPriceJPY: parseIntSafe(env.MAX_PRICE_JPY, null),
    },
    email: {
      enabled: env.EMAIL_ENABLED?.toLowerCase() === "true",
      smtpHost: env.SMTP_HOST ?? "",
      smtpPort: parseIntSafe(env.SMTP_PORT, 465) ?? 465,
      smtpSecure: (env.SMTP_SECURE ?? "true").toLowerCase() === "true",
      smtpUser: env.SMTP_USER ?? "",
      smtpPass: env.SMTP_PASS ?? "",
      emailTo: env.EMAIL_TO ?? "",
      alertPriceJPY: parseIntSafe(env.ALERT_PRICE_JPY, 70000) ?? 70000,
    },
    cron: {
      schedule: env.CRON_SCHEDULE ?? "0 0 * * *",
      timezone: env.CRON_TIMEZONE ?? "Asia/Tokyo",
    },
  };
}
