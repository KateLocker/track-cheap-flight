import "dotenv/config";
import { startCronScheduler } from "../cron-scheduler";
import { runFullSearch } from "../search-service";

async function main() {
  console.log("▶ Flight Tracker - Cron Daemon\n");
  const runOnStart = process.argv.includes("--now");

  if (runOnStart) {
    console.log("[cron] Running initial search first...");
    try {
      const res = await runFullSearch();
      console.log(
        `[cron] Initial: found=${res.flightsFound} min=${res.minPrice?.toLocaleString() || "-"} newLowest=${res.isNewLowest} email=${res.emailSent}`
      );
    } catch (e) {
      console.error("[cron] Initial search failed:", e);
    }
  }

  startCronScheduler();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
