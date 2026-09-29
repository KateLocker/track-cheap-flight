import { loadEnvConfig } from "@next/env";
import { runFullSearch } from "../search-service";
import { formatJPY } from "../email";

loadEnvConfig(process.cwd());

async function main() {
  console.log("▶ Running one-shot flight search...\n");
  const res = await runFullSearch();

  console.log("=== Search Result ===");
  console.log("Status     :", res.success ? "SUCCESS" : "FAILED/PARTIAL");
  if (res.error) console.log("Error      :", res.error);
  console.log("Flights    :", res.flightsFound);
  console.log("Min Price  :", res.minPrice != null ? formatJPY(res.minPrice) : "-");
  console.log("New Lowest :", res.isNewLowest);
  if (res.previousLowest != null) console.log("Prev Lowest:", formatJPY(res.previousLowest));
  console.log("Email Sent :", res.emailSent);
  if (res.emailError) console.log("Email Err  :", res.emailError);

  if (res.lowestFlight) {
    const f = res.lowestFlight;
    console.log("\n=== Cheapest Flight ===");
    console.log("Airline    :", f.airline_name || f.airline);
    console.log("Route      :", f.fly_from, "→", f.fly_to);
    console.log("Departure  :", f.departure_at);
    console.log("Return     :", f.return_at);
    console.log("Nights     :", f.nights_in_dest, "泊");
    console.log("Price      :", formatJPY(f.price));
    console.log("Link       :", f.deep_link || "-");
  }

  process.exitCode = res.success && !res.emailError ? 0 : 1;
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exitCode = 1;
});
