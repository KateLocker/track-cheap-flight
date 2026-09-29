import cron from "node-cron";
import { loadConfig } from "./config";
import { runFullSearch } from "./search-service";

export function startCronScheduler(): void {
  const cfg = loadConfig();
  const { schedule, timezone } = cfg.cron;
  if (!cron.validate(schedule)) throw new Error("CRON_SCHEDULE is not a valid cron expression.");
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
  let running = false;
  console.log(`[cron] Starting scheduler: ${schedule} (${timezone})`);
  const task = cron.schedule(schedule, async () => {
    if (running) {
      console.warn("[cron] Previous search is still running in this process; skipping this tick.");
      return;
    }
    running = true;
    try {
      const result = await runFullSearch(cfg, "light");
      console.log(`[cron] ${result.success ? "Completed" : "Failed"}: flights=${result.flightsFound}, min=${result.minPrice ?? "-"}, email=${result.emailSent ? "sent" : "skipped"}`);
      if (result.error) console.error(`[cron] Search error: ${result.error}`);
      if (result.emailError) console.error(`[cron] Email error: ${result.emailError}`);
    } catch (error) {
      console.error("[cron] Search failed:", error instanceof Error ? error.message : String(error));
    } finally { running = false; }
  }, { timezone });
  const stop = () => { task.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
