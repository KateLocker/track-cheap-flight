import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import axios from "axios";
import nodemailer from "nodemailer";
import { loadConfig, SearchConfig } from "../config";
import { searchSerpapiRoundTripHard } from "../google-flights-api";
import { searchRoundTripFlexible as searchKiwi } from "../kiwi-api";
import { searchRoundTripFlexible as searchAmadeus } from "../amadeus-api";
import { searchRoundTripFlexible as searchSky } from "../skyscanner-api";
import { runFullSearch } from "../search-service";
import { SearchBudget } from "../search-budget";

const cfg = (): SearchConfig => ({ flyFrom: "NRT", flyTo: "DLC", searchDaysAhead: 1, minNights: 7, maxNights: 7,
  adults: 1, selectAirlines: [], maxPriceJPY: null, nonStopOnly: true });
const serpParams = { api_key: "test-serp-key", fromAirports: ["NRT"], toAirports: ["DLC"], searchDaysAhead: 1,
  minNights: 7, maxNights: 7, maxCalls: 2, nonStopOnly: true };
function serpSegment(date: string, from = "NRT", to = "DLC") {
  return { flight_number: "NH 903", departure_airport: { id: from, time: `${date} 10:00` },
    arrival_airport: { id: to, time: `${date} 13:00` } };
}
function serpOffers(params: any): any[] {
  const out = serpSegment(params.outbound_date), back = serpSegment(params.return_date, "DLC", "NRT");
  return [
    { price: 30_000, flights: [[out, out], [back]] },
    { price: 35_000, flights: [[out], [back, back]] },
    { price: 40_000, flights: [[out], [back]], layovers: [{ id: "ICN" }] },
    { price: 45_000, flights: [[out], [{ ...back, technical_stops: 1 }]] },
    { price: 46_000, flights: [[out], [back]], layovers: null },
    { price: 47_000, flights: [[out], [back], [back]] },
    { price: 48_000, flights: [[out], [{ ...back, arrival_airport: undefined }]] },
    { price: 50_000, flights: [out] },
    { price: 80_000, flights: [[out], [back]], layovers: [] },
  ];
}

test("nonstop-only: both directions must be confirmed before saving or notifying", async t => {
  const originalGet = axios.get, originalPost = axios.post, originalTransport = nodemailer.createTransport, originalFetch = globalThis.fetch;
  const envNames = ["DATA_DIR", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN", "VERCEL", "VERCEL_ENV", "AMADEUS_ENV"];
  const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flight-nonstop-"));
  for (const name of envNames) delete process.env[name];
  process.env.DATA_DIR = dir;
  globalThis.fetch = async () => { throw new Error("Unexpected network access"); };
  axios.get = (async () => { throw new Error("Unmocked provider request"); }) as typeof axios.get;
  axios.post = (async () => { throw new Error("Unmocked provider request"); }) as typeof axios.post;
  nodemailer.createTransport = (() => { throw new Error("Unmocked SMTP request"); }) as typeof nodemailer.createTransport;
  try {
    await t.test("Serp rejects outbound/return connections, stops, malformed metadata and unknown return", async () => {
      const requests: any[] = [];
      axios.get = (async (_url: unknown, options: any) => { requests.push(options.params); return { data: { best_flights: serpOffers(options.params) } }; }) as typeof axios.get;
      const flights = await searchSerpapiRoundTripHard(serpParams);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].stops, 1);
      assert.deepEqual(flights.map(f => f.price), [80_000]);
      assert.equal(flights[0].isNonStop, true);
      requests.length = 0;
      const allFlights = await searchSerpapiRoundTripHard({ ...serpParams, nonStopOnly: false });
      assert.equal(requests[0].stops, undefined);
      assert.ok(allFlights.some(f => f.price === 30_000 && f.isNonStop === false));
    });
    await t.test("Serp excludes connecting outbound candidates and keeps stops=1 on the return-token request", async () => {
      const requests: any[] = [];
      axios.get = (async (_url: unknown, options: any) => {
        const p = options.params; requests.push(p);
        if (!p.departure_token) return { data: { best_flights: [
          { price: 20_000, departure_token: "connecting", flights: [serpSegment(p.outbound_date), serpSegment(p.outbound_date)] },
          { price: 70_000, departure_token: "nonstop", flights: [serpSegment(p.outbound_date)] },
        ] } };
        assert.equal(p.departure_token, "nonstop");
        return { data: { best_flights: [
          { price: 30_000, flights: [serpSegment(p.return_date, "DLC", "ICN"), serpSegment(p.return_date, "ICN", "NRT")] },
          { price: 80_000, flights: [serpSegment(p.return_date, "DLC", "NRT")] },
        ] } };
      }) as typeof axios.get;
      const flights = await searchSerpapiRoundTripHard(serpParams);
      assert.equal(requests.length, 2);
      assert.ok(requests.every(p => p.stops === 1));
      assert.deepEqual(flights.map(f => f.price), [80_000]);
    });
    await t.test("Kiwi sends max_stopovers=0 and checks technical stops and each journey direction", async () => {
      const route = [
        { airline: "NH", flyFrom: "NRT", flyTo: "DLC", local_departure: "2026-10-01T10:00:00", local_arrival: "2026-10-01T13:00:00", flight_no: 903, return: 0 },
        { airline: "NH", flyFrom: "DLC", flyTo: "NRT", local_departure: "2026-10-08T10:00:00", local_arrival: "2026-10-08T13:00:00", flight_no: 904, return: 1 },
      ];
      const valid = { id: "direct", price: 80_000, flyFrom: "NRT", flyTo: "DLC", technical_stops: 0, route };
      const offers = [valid,
        { ...valid, id: "out-connection", route: [route[0], route[0], route[1]] },
        { ...valid, id: "return-connection", route: [route[0], route[1], route[1]] },
        { ...valid, id: "technical", technical_stops: 1 }, { ...valid, id: "unknown-stops", technical_stops: undefined },
        { ...valid, id: "unknown-return", route: [route[0], { ...route[1], return: undefined }] },
        { ...valid, id: "wrong-destination", route: [route[0], { ...route[1], flyTo: "PEK" }] },
      ];
      let params: any;
      axios.get = (async (_url: unknown, options: any) => { params = options.params; return { data: { data: offers } }; }) as typeof axios.get;
      const result = await searchKiwi("test-kiwi", cfg());
      assert.equal(params.max_stopovers, 0);
      assert.deepEqual(result.map(f => f.id), ["direct"]);
      assert.equal(result[0].isNonStop, true);
      await searchKiwi("test-kiwi", { ...cfg(), nonStopOnly: false });
      assert.equal(params.max_stopovers, undefined);
    });
    await t.test("Amadeus requires one segment and numberOfStops=0 on both legs", async () => {
      axios.post = (async () => ({ data: { access_token: "fake-token", expires_in: 1800 } })) as typeof axios.post;
      let params: any;
      axios.get = (async (_url: unknown, options: any) => {
        params = options.params;
        const segment = (date: string, back = false) => ({ carrierCode: "NH", number: "903", numberOfStops: 0,
          departure: { iataCode: back ? "DLC" : "NRT", at: `${date}T10:00:00` }, arrival: { iataCode: back ? "NRT" : "DLC", at: `${date}T13:00:00` } });
        const out = segment(params.departureDate), back = segment(params.returnDate, true);
        const offer = (id: string, segments: any[][], price = 40_000) => ({ id, price: { total: String(price), currency: "JPY" }, itineraries: segments.map(s => ({ segments: s })) });
        return { data: { data: [offer("out-connection", [[out, out], [back]]), offer("return-connection", [[out], [back, back]]),
          offer("technical", [[out], [{ ...back, numberOfStops: 1 }]]), offer("unknown", [[out], [{ ...back, numberOfStops: undefined }]]),
          offer("nonstop", [[out], [back]], 80_000)] } };
      }) as typeof axios.get;
      const results = await searchAmadeus("nonstop-client", "test-secret", cfg(), { budget: new SearchBudget(2) });
      assert.equal(params.nonStop, true);
      assert.deepEqual(results.map(f => f.price), [80_000]);
      assert.equal(results[0].isNonStop, true);
      await searchAmadeus("nonstop-client", "test-secret", { ...cfg(), nonStopOnly: false }, { budget: new SearchBudget(1) });
      assert.equal(params.nonStop, false);
    });
    await t.test("Sky rejects unknown stopCount and inconsistent or malformed segments", async () => {
      axios.get = (async (url: string, options: any) => {
        if (url.includes("searchAirport")) return { data: { status: true, data: [{ skyId: options.params.query, entityId: options.params.query }] } };
        // No undocumented upstream nonstop/stops parameter is invented.
        assert.equal(options.params.stops, undefined);
        const out = { departure: `${options.params.date}T10:00:00`, arrival: `${options.params.date}T13:00:00`, stopCount: 0, segments: [{}] };
        const back = { ...out, departure: `${options.params.returnDate}T10:00:00`, arrival: `${options.params.returnDate}T13:00:00` };
        const offer = (id: string, legs: any[]) => ({ id, price: { raw: 80_000 }, legs });
        return { data: { status: true, data: { itineraries: [offer("nonstop", [out, back]),
          offer("no-segment-list", [{ ...out, segments: undefined }, { ...back, segments: undefined }]),
          offer("out-connection", [{ ...out, stopCount: 1 }, back]), offer("return-connection", [out, { ...back, stopCount: 1 }]),
          offer("unknown", [out, { ...back, stopCount: undefined }]), offer("contradictory", [out, { ...back, segments: [{}, {}] }]),
          offer("invalid-segment", [out, { ...back, segments: [null] }]), offer("empty-segments", [out, { ...back, segments: [] }]),
          offer("technical", [out, { ...back, segments: [{ numberOfStops: 1 }] }]), offer("missing-return", [out]),
        ] } } };
      }) as typeof axios.get;
      const result = await searchSky("test-sky", cfg(), new SearchBudget(3));
      assert.deepEqual(result.map(f => f.id), ["nonstop", "no-segment-list"]);
      assert.ok(result.every(f => f.isNonStop === true));
    });
    await t.test("only confirmed nonstop flights are persisted, compared and emailed; no-match stays successful", async () => {
      let sent = 0;
      const prices: string[] = [];
      nodemailer.createTransport = (() => ({ sendMail: async (message: { text: string }) => { sent++; prices.push(message.text); }, close() {} })) as unknown as typeof nodemailer.createTransport;
      axios.get = (async (_url: unknown, options: any) => ({ data: { best_flights: serpOffers(options.params) } })) as typeof axios.get;
      const config = loadConfig(); config.search = cfg();
      Object.assign(config, { serpApiKey: "test-serp-key", kiwiApiKey: "", rapidapiKey: "", amadeusClientId: "", amadeusClientSecret: "" });
      config.email = { enabled: true, smtpHost: "smtp.example.invalid", smtpPort: 465, smtpSecure: true,
        smtpUser: "tracker@example.invalid", smtpPass: "test", emailTo: "user@example.invalid", alertPriceJPY: 100_000 };
      const first = await runFullSearch(config);
      assert.equal(first.status, "success");
      assert.equal(first.flightsFound, 1);
      assert.equal(first.minPrice, 80_000);
      assert.equal(first.emailSent, true);
      assert.equal(JSON.parse(first.lowestFlight!.raw_data).metadata.isNonStop, true);
      assert.ok(prices[0].includes("80,000"));
      axios.get = (async (_url: unknown, options: any) => ({ data: { best_flights: serpOffers(options.params).filter(f => f.price !== 80_000) } })) as typeof axios.get;
      const second = await runFullSearch(config);
      assert.equal(second.status, "success");
      assert.equal(second.success, true);
      assert.equal(second.minPrice, null);
      assert.equal(second.flightsFound, 0);
      assert.equal(second.emailSent, false);
      assert.equal(sent, 1);
      const stored = JSON.parse(await fs.readFile(path.join(dir, "flights.json"), "utf8"));
      assert.equal(stored.searchRuns.length, 2);
      assert.equal(stored.flightRecords.length, 1);
      const nonstopLowest = stored.lowestPrices.find((row: any) => row.non_stop_only === true);
      assert.equal(nonstopLowest.min_price, 80_000);
    });
  } finally {
    axios.get = originalGet; axios.post = originalPost; nodemailer.createTransport = originalTransport; globalThis.fetch = originalFetch;
    for (const name of envNames) savedEnv[name] == null ? delete process.env[name] : process.env[name] = savedEnv[name];
    await fs.rm(dir, { recursive: true, force: true });
  }
});
