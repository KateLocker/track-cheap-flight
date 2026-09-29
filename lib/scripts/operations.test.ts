import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GET as dashboard } from "../../app/api/dashboard/route";
import { insertSearchRun, insertFlightRecord, insertNotificationLog } from "../db";
import { requireAdmin, requireCron } from "../auth";
import { loadConfig } from "../config";
import { InputError, readJSONObject, validateSearchRequest } from "../api-validation";
import { buildAlertEmail, formatDateTimeJST, safeBookingLink } from "../email";
import { POST as search } from "../../app/api/search/route";
import { POST as testEmail } from "../../app/api/test-email/route";
import { GET as backupGET, POST as backupPOST } from "../../app/api/data-backup/route";
import { GET as debugSearch } from "../../app/api/debug-search/route";
import { GET as debugProvider } from "../../app/api/debug-provider/route";
import { GET as diagnostic } from "../../app/api/diagnostic/route";
import { GET as cron } from "../../app/api/cron/route";

const token = "operations-test-token-01234567890123456789";
function request(path: string, body?: unknown, authorized = true) {
  return new Request(`http://localhost/api/${path}`, {
    method: "POST",
    headers: authorized ? { authorization: `Bearer ${token}`, "content-type": "application/json" } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// All authorized network-capable operations below either fail validation or use
// a fake SMTP transport. No test sends mail or queries a flight provider.
test("administrative APIs fail closed and validate input before side effects", async t => {
  const keys = ["ADMIN_TOKEN", "CRON_SECRET", "VERCEL", "EMAIL_ENABLED", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "EMAIL_TO", "FLY_FROM", "FLY_TO", "SEARCH_DAYS_AHEAD", "MIN_NIGHTS", "MAX_NIGHTS", "ADULTS", "SELECT_AIRLINES", "ALERT_PRICE_JPY"];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    await t.test("all sensitive handlers reject missing configuration", async () => {
      delete process.env.ADMIN_TOKEN;
      delete process.env.CRON_SECRET;
      process.env.VERCEL = "1";
      const handlers = [search, testEmail, backupGET, backupPOST, debugSearch, debugProvider, diagnostic, cron];
      for (const handler of handlers) {
        const response = await handler(new Request("https://test.vercel.app/api/example", { headers: { host: "test.vercel.app" } }));
        assert.equal(response.status, 503);
      }
    });
    process.env.ADMIN_TOKEN = token;
    process.env.CRON_SECRET = "a-different-cron-token-0123456789012345";
    await t.test("admin and cron credentials are separate", async () => {
      assert.equal(requireAdmin(request("search", {}, false))?.status, 401);
      assert.equal(requireAdmin(request("search")), null);
      assert.equal(requireCron(request("cron"))?.status, 401);
      assert.equal(requireCron(new Request("http://localhost/api/cron", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })), null);
      process.env.ADMIN_TOKEN = "too-short";
      assert.equal(requireAdmin(request("search"))?.status, 503);
      process.env.ADMIN_TOKEN = token;
    });
    await t.test("invalid search fields are rejected before calling a provider", async () => {
      const cases = [
        { flyFrom: "NRT,HND" }, { flyFrom: "TYO", flyTo: "TYO" },
        { searchDaysAhead: 366 }, { searchDaysAhead: "12days" },
        { adults: 0 }, { adults: 10 }, { minNights: 15, maxNights: 5 },
        { minNights: -1 }, { maxNights: 91 }, { selectAirlines: ["ANA"] },
        { maxPriceJPY: 0 }, { alertPriceJPY: -1 }, { mode: "anything" }, { unexpected: true },
        { nonStopOnly: "false" }, { nonStopOnly: 0 }, { nonStopOnly: null },
      ];
      for (const body of cases) assert.equal((await search(request("search", body))).status, 400);
      assert.equal((await search(new Request("http://localhost/api/search", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{" }))).status, 400);
    });
    await t.test("empty JSON bodies are accepted; valid boundaries stay intact", async () => {
      assert.deepEqual(await readJSONObject(request("test-email")), {});
      await assert.rejects(readJSONObject(request("search", [])), InputError);
      await assert.rejects(readJSONObject(request("search", { padding: "x".repeat(20_000) })), InputError);
      const config = validateSearchRequest({ flyFrom: "nrt", flyTo: "dlc", searchDaysAhead: 365, minNights: 0, maxNights: 90, adults: 9, selectAirlines: "nh,JL,nh" }, loadConfig());
      assert.equal(config.search.flyFrom, "NRT");
      assert.equal(config.search.searchDaysAhead, 365);
      assert.deepEqual(config.search.selectAirlines, ["NH", "JL"]);
      const defaults = loadConfig();
      assert.equal(validateSearchRequest({}, defaults).search.nonStopOnly, defaults.search.nonStopOnly);
      assert.equal(validateSearchRequest({ nonStopOnly: true }, defaults).search.nonStopOnly, true);
      assert.equal(validateSearchRequest({ nonStopOnly: false }, defaults).search.nonStopOnly, false);
    });
    await t.test("test email forbids recipient override and works with an empty body", async () => {
      assert.equal((await testEmail(request("test-email", { email: "unconfigured@example.test" }))).status, 400);
      process.env.EMAIL_ENABLED = "false";
      assert.equal((await testEmail(request("test-email"))).status, 503);
      Object.assign(process.env, { EMAIL_ENABLED: "true", SMTP_HOST: "smtp.example.test", SMTP_USER: "sender@example.test", SMTP_PASS: "fake-password", EMAIL_TO: "configured@example.test" });
      const original = nodemailer.createTransport;
      let envelope: any;
      let transportOptions: any;
      let closed = false;
      nodemailer.createTransport = ((options: unknown) => {
        transportOptions = options;
        return { sendMail: async (mail: unknown) => { envelope = mail; return {}; }, close: () => { closed = true; } };
      }) as typeof nodemailer.createTransport;
      try {
        const response = await testEmail(request("test-email"));
        assert.equal(response.status, 200);
        assert.equal(envelope.to, "configured@example.test");
        assert.match(envelope.subject, /TEST/);
        assert.equal(transportOptions.connectionTimeout, 5000);
        assert.equal(transportOptions.socketTimeout, 15000);
        assert.equal(closed, true);
        assert.equal((await testEmail(request("test-email"))).status, 429);
      } finally { nodemailer.createTransport = original; }
    });
  } finally {
    for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  }
});

test("mail content uses actual routes, escapes HTML, and preserves local flight dates", () => {
  const flight = {
    search_run_id: 1, price: 60000, currency: "JPY", fly_from: "KIX", fly_to: "PEK",
    airline: "CA", airline_name: '<img src=x onerror="bad()">',
    departure_at: "2027-01-01T00:30:00+09:00", return_at: "2027-01-08T23:30:00-08:00",
    nights_in_dest: 7, deep_link: 'javascript:alert("bad")', booking_token: "", raw_data: "",
  };
  const email = buildAlertEmail({ flight, isNewLowest: false, alertPrice: 70000 });
  assert.match(email.subject, /KIX → PEK/);
  assert.doesNotMatch(email.subject, /ANA|東京/);
  assert.doesNotMatch(email.html, /<img|javascript:/);
  assert.match(email.html, /&lt;img/);
  assert.equal(formatDateTimeJST(flight.departure_at), "2027/01/01 00:30");
  assert.equal(formatDateTimeJST(flight.return_at), "2027/01/08 23:30");
  assert.equal(safeBookingLink("data:text/html,bad"), "");
  assert.equal(safeBookingLink("https://user:password@example.test"), "");
  assert.equal(safeBookingLink("https://example.test/booking?x=1&y=2"), "https://example.test/booking?x=1&y=2");
  const retry = buildAlertEmail({ flight: { ...flight, price: 90000 }, isNewLowest: false, alertPrice: 70000 });
  assert.doesNotMatch(retry.text, /以下の航空券/);
  assert.match(retry.text, /再送/);
});


test("public dashboard reports unavailable storage and only exposes route-filtered display fields", async () => {
  const keys = ["VERCEL", "VERCEL_ENV", "DATA_DIR", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN", "ADMIN_TOKEN"];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const directory = await mkdtemp(path.join(tmpdir(), "flight-dashboard-test-"));
  try {
    for (const key of keys) delete process.env[key];
    process.env.ADMIN_TOKEN = token;
    process.env.VERCEL = "1";
    const unavailable = await dashboard(new Request("http://localhost/api/dashboard"));
    assert.equal(unavailable.status, 503);
    const unavailableData = await unavailable.json();
    assert.equal(unavailableData.storage.configured, false);
    assert.equal(unavailableData.config.adminConfigured, true);
    assert.equal(unavailableData.config.cronTimezone, "UTC");
    assert.equal(unavailableData.config.cronSchedule, "0 0 * * *");
    assert.deepEqual(unavailableData.recentFlights, []);
    assert.match(unavailableData.error, /Persistent storage is not configured/);
    delete process.env.VERCEL;
    process.env.DATA_DIR = directory;
    const now = new Date().toISOString();
    const runId = await insertSearchRun({ started_at: now, finished_at: now, flights_found: 2, min_price: 60000, status: "partial", error_message: "private-provider-detail-do-not-expose" });
    const fields = { search_run_id: runId, price: 60000, currency: "JPY", airline: "NH", airline_name: "ANA", departure_at: "2027-01-01T00:30:00+09:00", return_at: "2027-01-08T00:30:00+09:00", nights_in_dest: 7, booking_token: "private-booking-token", deep_link: "https://example.test/booking", raw_data: "private-provider-payload" };
    const first = await insertFlightRecord({ ...fields, fly_from: "TYO", fly_to: "DLC" });
    await insertFlightRecord({ ...fields, fly_from: "OSA", fly_to: "PEK" });
    await insertNotificationLog({ flight_record_id: first, recipient: "private-recipient@example.test", price: 60000, success: 1, error_message: null });
    const response = await dashboard(new Request("http://localhost/api/dashboard?flyFrom=TYO&flyTo=DLC&nonStopOnly=false"));
    assert.equal(response.status, 200);
    const text = await response.text();
    const data = JSON.parse(text);
    assert.equal(data.recentFlights.length, 1);
    assert.equal(data.recentFlights[0].fly_from, "TYO");
    assert.equal(data.recentFlights[0].fly_to, "DLC");
    assert.doesNotMatch(text, /private-provider|private-booking|private-recipient|booking_token|raw_data/);
    assert.equal((await dashboard(new Request("http://localhost/api/dashboard?flyFrom=INVALID"))).status, 400);
  } finally {
    for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    await rm(directory, { recursive: true, force: true });
  }
});
