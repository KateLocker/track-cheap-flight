import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import axios from "axios";
import nodemailer from "nodemailer";
import { loadConfig, AppConfig } from "../config";
import { runFullSearch } from "../search-service";
import { SearchBudget, dateText, sampleDepartureDates } from "../search-budget";
import { searchSerpapiRoundTripHard } from "../google-flights-api";
import { getReturnLegDeparture, KiwiFlight } from "../kiwi-api";

function config(): AppConfig {
  const cfg = loadConfig();
  Object.assign(cfg, { serpApiKey: "test-serp-key", kiwiApiKey: "", rapidapiKey: "", amadeusClientId: "", amadeusClientSecret: "" });
  cfg.search = { flyFrom: "TYO", flyTo: "DLC", searchDaysAhead: 1, minNights: 7, maxNights: 7, adults: 1, selectAirlines: ["NH"], maxPriceJPY: null, nonStopOnly: false };
  cfg.email = { enabled: false, smtpHost: "smtp.example.invalid", smtpPort: 465, smtpSecure: true,
    smtpUser: "tracker@example.invalid", smtpPass: "test-only", emailTo: "recipient@example.invalid", alertPriceJPY: 70_000 };
  return cfg;
}
function segment(date: string, airline = "NH", returning = false) {
  return { flight_number: `${airline} 903`, departure_airport: { id: returning ? "DLC" : "NRT", time: `${date} 10:00` },
    arrival_airport: { id: returning ? "NRT" : "DLC", time: `${date} 13:00` } };
}
function complete(params: any, price = 55_000, outboundAirline = "NH", returnAirline = outboundAirline) {
  return { data: { best_flights: [{ price, flights: [[segment(params.outbound_date, outboundAirline)], [segment(params.return_date, returnAirline, true)]] }] } };
}
const hardParams = { api_key: "fixture-only", fromAirports: ["NRT", "HND"], toAirports: ["DLC"], searchDaysAhead: 90,
  minNights: 3, maxNights: 14, maxCalls: 16 };

test("search regressions: isolated providers, durable records and notification retries", async t => {
  const originalGet = axios.get;
  const originalPost = axios.post;
  const originalTransport = nodemailer.createTransport;
  const originalFetch = globalThis.fetch;
  const variables = ["DATA_DIR", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN", "VERCEL", "VERCEL_ENV", "AMADEUS_ENV"];
  const savedEnv = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flight-search-regression-"));
  for (const name of variables) delete process.env[name];
  globalThis.fetch = async () => { throw new Error("Network is forbidden in regression tests"); };
  axios.post = (async () => { throw new Error("Unexpected provider authentication request"); }) as typeof axios.post;
  nodemailer.createTransport = (() => { throw new Error("Unexpected SMTP request"); }) as typeof nodemailer.createTransport;
  let fixtureNumber = 0;
  const resetStore = () => { process.env.DATA_DIR = path.join(dir, String(++fixtureNumber)); };
  try {
    await t.test("16 requests sample the complete 90-day range across city airports", async () => {
      const queries: any[] = [];
      axios.get = (async (_url: unknown, options: any) => { queries.push(options.params); return { data: { best_flights: [] } }; }) as typeof axios.get;
      await searchSerpapiRoundTripHard(hardParams);
      assert.equal(queries.length, 16);
      const dates = Array.from(new Set(queries.map(q => q.outbound_date))).sort();
      assert.equal(dates.length, 8);
      const expected = sampleDepartureDates(90, 8).map(dateText).sort();
      assert.deepEqual(dates, expected);
      assert.ok(queries.every(q => q.departure_id === "NRT,HND"));
      const yearDates = sampleDepartureDates(365, 8, new Date("2026-01-01T12:00:00"));
      assert.equal(dateText(yearDates[0]), "2026-01-02");
      assert.equal(dateText(yearDates[1]), "2027-01-01");
    });
    await t.test("strict airline filtering rejects other carriers and mixed return journeys", async () => {
      resetStore();
      axios.get = (async (_url: unknown, options: any) => ({ data: { best_flights: [
        ...complete(options.params, 40_000, "OZ").data.best_flights,
        ...complete(options.params, 45_000, "NH", "CA").data.best_flights,
        ...complete(options.params, 60_000).data.best_flights,
      ] } })) as typeof axios.get;
      const result = await runFullSearch(config());
      assert.equal(result.minPrice, 60_000);
      assert.equal(result.flightsFound, 1);
      assert.equal(result.lowestFlight?.airline, "NH");
    });
    await t.test("Serp return-token expansion uses correct filter and confirms both legs", async () => {
      resetStore();
      let calls = 0;
      axios.get = (async (_url: unknown, options: any) => {
        calls++;
        assert.equal(options.params.include_airlines, "NH");
        assert.equal(options.params.airline_codes, undefined);
        return { data: { best_flights: options.params.departure_token
          ? [{ price: 58_000, booking_token: "confirmed", flights: [segment(options.params.return_date, "NH", true)] }]
          : [{ price: 50_000, departure_token: "select-outbound", flights: [segment(options.params.outbound_date)] }] } };
      }) as typeof axios.get;
      const result = await runFullSearch(config());
      assert.equal(calls, 2);
      assert.equal(result.minPrice, 58_000);
      assert.equal(result.status, "success");
      assert.equal(result.lowestFlight?.booking_token, "confirmed");
    });
    await t.test("missing return is date-only and cannot become a monitored low price", async () => {
      resetStore();
      axios.get = (async (_url: unknown, options: any) => ({ data: { best_flights: [
        { price: 45_000, flights: [segment(options.params.outbound_date)] },
      ] } })) as typeof axios.get;
      const [raw] = await searchSerpapiRoundTripHard({ ...hardParams, maxCalls: 1 });
      assert.match(raw.return_departure, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(raw.return_arrival, "");
      assert.equal(raw.itineraryComplete, false);
      const cfg = config(); cfg.search.selectAirlines = [];
      const result = await runFullSearch(cfg);
      assert.equal(result.minPrice, null);
      assert.equal(result.status, "failed");
      assert.ok(result.warnings.some(s => s.includes("返程")));
    });
    await t.test("deadline cancels the active request and preserves earlier successful results", async () => {
      resetStore();
      const cfg = config(); cfg.search.searchDaysAhead = 90; cfg.search.minNights = 3; cfg.search.maxNights = 14;
      let calls = 0;
      let aborted = false;
      axios.get = ((_url: unknown, options: any) => {
        calls++;
        if (calls === 1) return Promise.resolve(complete(options.params));
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("canceled"), { code: "ERR_CANCELED" })); }, { once: true });
        });
      }) as typeof axios.get;
      const result = await runFullSearch(cfg, "full", { budget: new SearchBudget(16, 100) });
      assert.equal(aborted, true);
      assert.equal(result.flightsFound, 1);
      assert.equal(result.status, "partial");
      assert.equal(result.success, true);
      assert.equal(calls, 2);
      await new Promise(r => setTimeout(r, 30));
      assert.equal(calls, 2, "no requests may continue after the search returns");
      const data = JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR!, "flights.json"), "utf8"));
      assert.equal(data.searchRuns[0].status, "partial");
      assert.equal(data.flightRecords.length, 1);
    });
    await t.test("401 terminates the provider without retrying another date or night", async () => {
      let calls = 0;
      axios.get = (async () => { calls++; throw Object.assign(new Error("unauthorized"), { response: { status: 401 } }); }) as typeof axios.get;
      const result = await searchSerpapiRoundTripHard(hardParams);
      assert.equal(calls, 1);
      assert.equal(result.length, 0);
    });
    await t.test("all providers share one request cap including lookup and authentication", async () => {
      resetStore();
      let calls = 0;
      axios.get = (async (url: string) => {
        calls++;
        if (url.includes("searchAirport")) return { data: { status: true, data: [{ skyId: "NRT", entityId: "1" }] } };
        if (url.includes("sky-scrapper")) return { data: { status: true, data: { itineraries: [] } } };
        if (url.includes("amadeus") || url.includes("kiwi")) return { data: { data: [] } };
        return { data: { best_flights: [] } };
      }) as typeof axios.get;
      axios.post = (async () => { calls++; return { data: { access_token: "fake-token", expires_in: 1800 } }; }) as typeof axios.post;
      const cfg = config(); Object.assign(cfg, { kiwiApiKey: "test-kiwi-key", rapidapiKey: "test-rapid-key", amadeusClientId: "test-amadeus-client", amadeusClientSecret: "test-amadeus-secret" });
      cfg.search.searchDaysAhead = 90; cfg.search.minNights = 3; cfg.search.maxNights = 14;
      const result = await runFullSearch(cfg, "light");
      assert.equal(result.coverage.requestsMade, calls);
      assert.equal(result.coverage.requestLimit, 10);
      assert.ok(calls <= 10);
      assert.equal(result.status, "success");
    });
    await t.test("same-day travel preserves zero nights", async () => {
      resetStore();
      const cfg = config(); cfg.search.minNights = 0; cfg.search.maxNights = 0;
      axios.get = (async (_url: unknown, options: any) => {
        assert.equal(options.params.outbound_date, options.params.return_date);
        return complete(options.params);
      }) as typeof axios.get;
      const result = await runFullSearch(cfg);
      assert.equal(result.lowestFlight?.nights_in_dest, 0);
    });
    await t.test("two searches persist independently but send only one alert for the same flight", async () => {
      resetStore();
      let sent = 0;
      nodemailer.createTransport = (() => ({ sendMail: async () => { sent++; }, close() {} })) as unknown as typeof nodemailer.createTransport;
      axios.get = (async (_url: unknown, options: any) => complete(options.params)) as typeof axios.get;
      const cfg = config(); cfg.email.enabled = true;
      const first = await runFullSearch(cfg);
      const second = await runFullSearch(cfg);
      assert.equal(first.emailSent, true);
      assert.equal(second.emailSent, false);
      assert.equal(sent, 1);
      const data = JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR!, "flights.json"), "utf8"));
      assert.equal(data.searchRuns.length, 2);
      assert.equal(data.flightRecords.length, 2);
      assert.equal(data.notificationLogs.length, 1);
      assert.notEqual(data.flightRecords[0].id, data.flightRecords[1].id);
    });
    await t.test("a failed new-low email above threshold is retried after releasing its claim", async () => {
      resetStore();
      let attempts = 0;
      let retryText = "";
      nodemailer.createTransport = (() => ({ sendMail: async (message: { text: string }) => { if (++attempts === 1) throw new Error("SMTP unavailable"); retryText = message.text; }, close() {} })) as unknown as typeof nodemailer.createTransport;
      axios.get = (async (_url: unknown, options: any) => complete(options.params, 90_000)) as typeof axios.get;
      const cfg = config(); cfg.email.enabled = true;
      const first = await runFullSearch(cfg);
      const second = await runFullSearch(cfg);
      const third = await runFullSearch(cfg);
      assert.equal(first.success, true);
      assert.ok(first.emailError);
      assert.equal(first.emailSent, false);
      assert.equal(second.isNewLowest, false);
      assert.equal(second.emailSent, true);
      assert.equal(third.emailSent, false);
      assert.equal(attempts, 2);
      assert.ok(!retryText.includes("以下の航空券"), "retry must not falsely claim a fare is below the alert threshold");
      const data = JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR!, "flights.json"), "utf8"));
      assert.deepEqual(data.notificationLogs.map((log: any) => log.success), [0, 1]);
    });
    await t.test("invalid environment search settings fail before any paid request", async () => {
      resetStore();
      let calls = 0;
      axios.get = (async () => { calls++; return { data: {} }; }) as typeof axios.get;
      const cfg = config(); cfg.search.searchDaysAhead = 366;
      await assert.rejects(runFullSearch(cfg), /1–365/);
      assert.equal(calls, 0);
    });
    await t.test("Kiwi identifies the return leg by direction instead of matching an outbound airline", () => {
      const f = { flyTo: "DLC", local_arrival: "2026-10-02T13:00:00", route: [
        { airline: "NH", flyFrom: "NRT", flyTo: "ICN", local_departure: "2026-10-02T08:00:00", return: 0 },
        { airline: "NH", flyFrom: "ICN", flyTo: "DLC", local_departure: "2026-10-02T11:00:00", return: 0 },
        { airline: "NH", flyFrom: "DLC", flyTo: "NRT", local_departure: "2026-10-09T10:00:00", return: 1 },
      ] } as KiwiFlight;
      assert.equal(getReturnLegDeparture(f), "2026-10-09T10:00:00");
    });
  } finally {
    axios.get = originalGet; axios.post = originalPost; nodemailer.createTransport = originalTransport; globalThis.fetch = originalFetch;
    for (const name of variables) savedEnv[name] == null ? delete process.env[name] : process.env[name] = savedEnv[name];
    await fs.rm(dir, { recursive: true, force: true });
  }
});
