import cron from "node-cron";
import { loadConfig } from "./config";
import { runFullSearch } from "./search-service";

export function startCronScheduler(): void {
  const cfg = loadConfig();
  const { schedule, timezone } = cfg.cron;

  console.log(`[cron] Starting scheduler with schedule="${schedule}" timezone="${timezone}"`);
  console.log(`[cron] Next search times (first 5):`);

  cron.schedule(
    schedule,
    async () => {
      const startedAt = new Date().toISOString();
      console.log(`\n[cron] ▶ Triggered search at ${startedAt}`);
      try {
        const result = await runFullSearch(cfg);
        const summary = [
          `[cron] ✅ Completed`,
          `Found: ${result.flightsFound} flights`,
          `Min: ${result.minPrice != null ? `¥${result.minPrice.toLocaleString()}` : "-"}`,
          `NewLowest: ${result.isNewLowest}`,
          `Email: ${result.emailSent ? "sent" : "skipped"}${result.emailError ? ` (err: ${result.emailError.slice(0, 80)})` : ""}`,
          result.error ? `⚠ API warn: ${result.error.slice(0, 120)}` : "",
        ].filter(Boolean).join(" | ");
        console.log(summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[cron] ❌ Fatal error: ${msg}`);
      }
    },
    {
      timezone,
    } as never
  );

  console.log(`[cron] Scheduler started. Press Ctrl+C to stop.`);
}
