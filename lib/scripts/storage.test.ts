import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  claimNotification, exportStoreJSON, getDb, getStorageStatus, importStoreJSON,
  insertSearchRun, listRecentFlights, listSearchRuns, persistSearchRun, listAllLowestPrices, getPriceHistory, listCheapestByDay,
  releaseNotificationClaim, getLatestLowestPrice, upsertLowestPrice, hasFailedNotification, insertNotificationLog,
  type FlightRecord, type SearchRun,
} from "../db";
import { GET as dashboardGET } from "../../app/api/dashboard/route";

const run: Omit<SearchRun, "id"> = {
  started_at: "2026-09-28T00:00:00.000Z", finished_at: "2026-09-28T00:00:01.000Z",
  flights_found: 1, min_price: 10000, status: "success", error_message: null,
};
const flight: FlightRecord = {
  search_run_id: 1, price: 10000, currency: "JPY", fly_from: "TYO", fly_to: "DLC",
  airline: "NH", airline_name: "ANA", departure_at: "2026-10-01T12:00:00.000Z",
  return_at: "2026-10-08T12:00:00.000Z", nights_in_dest: 7, booking_token: "",
  deep_link: "https://example.com/flights", raw_data: "{}",
};
const environmentKeys = ["DATA_DIR", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL",
  "KV_REST_API_TOKEN", "FLIGHT_STORAGE_KEY", "VERCEL", "VERCEL_ENV", "NONSTOP_ONLY"];

function mockRedis() {
  const values = new Map<string, { value: string; expires?: number }>();
  let conflicts = 0;
  let calls = 0;
  const read = (key: string): string | null => {
    const entry = values.get(key);
    if (entry?.expires && entry.expires <= Date.now()) { values.delete(key); return null; }
    return entry?.value ?? null;
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://storage.test");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer fake-test-token");
    assert.equal(init?.cache, "no-store");
    const args = JSON.parse(String(init?.body)) as Array<string | number>;
    calls++;
    let result: unknown;
    const key = String(args[1]);
    if (args[0] === "GET") result = read(key);
    else if (args[0] === "SET") {
      assert.deepEqual(args.slice(3, 6), ["NX", "EX", args[5]]);
      if (read(key) !== null) result = null;
      else {
        values.set(key, { value: String(args[2]), expires: Date.now() + Number(args[5]) * 1000 });
        result = "OK";
      }
    } else if (args[0] === "EVAL") {
      assert.equal(args[2], 1);
      const redisKey = String(args[3]);
      const script = String(args[1]);
      if (script.includes("redis.call('SET'")) {
        assert.ok(script.includes("current == ARGV[2]"));
        const current = read(redisKey);
        if ((args[4] === "0" && current === null) || (args[4] === "1" && current === args[5])) {
          values.set(redisKey, { value: String(args[6]) });
          result = 1;
        } else { conflicts++; result = 0; }
      } else {
        assert.ok(script.includes("redis.call('GET', KEYS[1]) == ARGV[1]"));
        if (read(redisKey) === args[4]) { values.delete(redisKey); result = 1; }
        else result = 0;
      }
    } else throw new Error(`Unexpected mock command ${args[0]}`);
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
  return { fetch, values, read, get conflicts() { return conflicts; }, get calls() { return calls; } };
}

test("durable flight storage", async t => {
  const savedEnv = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "flight-storage-test-"));
  const resetEnv = () => { for (const key of environmentKeys) delete process.env[key]; };
  try {
    await t.test("local data is persisted immediately and independent processes do not lose updates", async () => {
      resetEnv();
      process.env.DATA_DIR = path.join(tempDir, "local");
      assert.deepEqual(getStorageStatus(), { provider: "local-json", configured: true });
      await Promise.all(Array.from({ length: 8 }, () => insertSearchRun(run)));
      const modulePath = path.resolve("lib/db.ts");
      const script = `import db from ${JSON.stringify(modulePath)}; for(let i=0;i<4;i++) await db.insertSearchRun(${JSON.stringify(run)});`;
      await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), env: { ...process.env } })));
      const records = await listSearchRuns(100);
      assert.equal(records.length, 20);
      assert.equal(new Set(records.map(record => record.id)).size, 20);
      const persisted = JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR!, "flights.json"), "utf8"));
      assert.equal(persisted.searchRuns.length, 20);
      assert.equal(persisted.nextId.searchRuns, 21);
      assert.deepEqual((await fs.readdir(process.env.DATA_DIR!)).sort(), ["flights.json"]);
      // No module cache may mask an update made outside the current process.
      persisted.searchRuns[0].error_message = "external update";
      await fs.writeFile(path.join(process.env.DATA_DIR!, "flights.json"), JSON.stringify(persisted));
      assert.equal((await listSearchRuns(100)).find(row => row.id === 1)?.error_message, "external update");
    });

    await t.test("backup validation rejects unsafe or malformed input without changing stored records", async () => {
      const before = await exportStoreJSON();
      for (const invalid of ["{}", "[]", "null", "{", JSON.stringify({ ...JSON.parse(before), surprise: true })]) {
        assert.equal(await importStoreJSON(invalid), false);
        assert.equal(await exportStoreJSON(), before);
      }
      const badCounter = JSON.parse(before);
      badCounter.nextId.searchRuns = 1;
      assert.equal(await importStoreJSON(JSON.stringify(badCounter)), false);
      const badId = JSON.parse(before);
      badId.searchRuns[1].id = badId.searchRuns[0].id;
      assert.equal(await importStoreJSON(JSON.stringify(badId)), false);
      const dangerousLink = JSON.parse(before);
      dangerousLink.flightRecords = [{ ...flight, id: 1, deep_link: "javascript:alert(1)" }];
      dangerousLink.nextId.flightRecords = 2;
      assert.equal(await importStoreJSON(JSON.stringify(dangerousLink)), false);
      const proto = before.replace('"searchRuns":', '"__proto__":{},"searchRuns":');
      assert.equal(await importStoreJSON(proto), false);
      assert.equal(await exportStoreJSON(), before);
      // The original store did not contain notificationClaims.
      const legacy = JSON.parse(before);
      delete legacy.notificationClaims;
      assert.equal(await importStoreJSON(JSON.stringify(legacy)), true);
      assert.deepEqual(JSON.parse(await exportStoreJSON()).notificationClaims, {});
    });

    await t.test("corrupt local data fails visibly and only a valid backup can restore it", async () => {
      const backup = await exportStoreJSON();
      const file = path.join(process.env.DATA_DIR!, "flights.json");
      await fs.writeFile(file, "{broken");
      await assert.rejects(getDb(), /Stored flight data is invalid/);
      await assert.rejects(insertSearchRun(run), /Stored flight data is invalid/);
      assert.equal(await fs.readFile(file, "utf8"), "{broken");
      assert.equal(await importStoreJSON(backup), true);
      assert.equal((await listSearchRuns(100)).length, 20);
    });

    await t.test("local notification claims deduplicate searches and safely release failed delivery", async () => {
      const claims = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        claimNotification({ ...flight, id: index + 1, search_run_id: index + 1 }, "person@example.test")));
      const successful = claims.filter((key): key is string => key !== null);
      assert.equal(successful.length, 1);
      assert.equal(await claimNotification(flight, "PERSON@example.test"), null);
      assert.ok(await claimNotification({ ...flight, price: 9000 }, "person@example.test"));
      assert.ok(await claimNotification(flight, "someone-else@example.test"));
      await releaseNotificationClaim(successful[0]);
      const newClaim = await claimNotification(flight, "person@example.test");
      assert.ok(newClaim);
      await releaseNotificationClaim(successful[0]);
      assert.equal(await claimNotification(flight, "person@example.test"), null);
    });

    await t.test("failed new-low alerts remain retryable after 24 hours until this itinerary is sent successfully", async () => {
      const { search_run_id: _ignored, ...record } = flight;
      const saved = await persistSearchRun(run, [record]);
      const retryFlight = { ...flight, id: saved.flightRecordIds[0], search_run_id: saved.searchRunId };
      await insertNotificationLog({ flight_record_id: retryFlight.id, recipient: "person@example.test",
        price: flight.price, success: 0, error_message: "mock SMTP failure" });
      const backup = JSON.parse(await exportStoreJSON());
      backup.notificationLogs[0].sent_at = new Date(Date.now() - 25 * 3600000).toISOString();
      await importStoreJSON(JSON.stringify(backup));
      assert.equal(await hasFailedNotification({ ...retryFlight, id: 999, search_run_id: 999 }, "PERSON@example.test"), true);
      assert.equal(await hasFailedNotification(retryFlight, "person@example.test", 12), false);
      assert.equal(await hasFailedNotification({ ...retryFlight, price: 9000 }, "person@example.test"), false);
      assert.equal(await hasFailedNotification(retryFlight, "other@example.test"), false);
      await insertNotificationLog({ flight_record_id: retryFlight.id, recipient: "person@example.test",
        price: flight.price, success: 1, error_message: null });
      assert.equal(await hasFailedNotification(retryFlight, "person@example.test"), false);
    });

    await t.test("nonstop history excludes connecting, unknown and unverified legacy fares without deleting them", async () => {
      const previousDir = process.env.DATA_DIR;
      process.env.DATA_DIR = path.join(tempDir, "nonstop");
      try {
        const { search_run_id: _ignored, ...record } = flight;
        const records = [
          { ...record, price: 10000, raw_data: "{}" },
          { ...record, price: 8000, raw_data: JSON.stringify({ metadata: { isNonStop: false } }) },
          { ...record, price: 5000, raw_data: JSON.stringify({ metadata: { isNonStop: "true" } }) },
          { ...record, price: 1000, raw_data: "not-json" },
          { ...record, price: 30000, raw_data: JSON.stringify({ metadata: { isNonStop: true } }) },
          { ...record, price: 25000, raw_data: JSON.stringify({ metadata: { isNonStop: true } }) },
        ];
        const saved = await persistSearchRun({ ...run, flights_found: records.length }, records);
        const lowest = { fly_from: "TYO", fly_to: "DLC", min_price: 8000, currency: "JPY", airline: "NH",
          departure_at: flight.departure_at, return_at: flight.return_at, nights_in_dest: 7,
          deep_link: flight.deep_link, flight_record_id: saved.flightRecordIds[1] };
        await upsertLowestPrice(lowest);
        assert.equal((await getLatestLowestPrice("TYO", "DLC"))?.min_price, 1000);
        // Direct cards are rebuilt from confirmed records rather than the lower connecting cache.
        assert.equal((await getLatestLowestPrice("TYO", "DLC", true))?.min_price, 25000);
        assert.deepEqual((await listRecentFlights(100, "TYO", "DLC", true)).map(row => row.price), [25000, 30000]);
        assert.equal((await listRecentFlights(100, "TYO", "DLC")).length, 6);
        assert.equal((await listCheapestByDay(30, "TYO", "DLC", true))[0].price, 25000);
        assert.equal((await getPriceHistory("TYO", "DLC", 30, true))[0].min_price, 25000);
        assert.equal((await getPriceHistory("TYO", "DLC", 30))[0].min_price, 1000);
        assert.deepEqual(await getLatestLowestPrice("TYO", "PEK", true), null);
        assert.deepEqual(await upsertLowestPrice({ ...lowest, non_stop_only: true, min_price: 25000,
          flight_record_id: saved.flightRecordIds[5] }), { previousLowest: 25000, isNewLowest: false });
        assert.equal((await listAllLowestPrices("TYO", "DLC", true))[0].min_price, 25000);
        assert.equal((await listAllLowestPrices("TYO", "DLC", false))[0].min_price, 1000);
        const exported = JSON.parse(await exportStoreJSON());
        assert.equal(exported.lowestPrices.length, 2);
        assert.equal(await importStoreJSON(JSON.stringify(exported)), true);
        exported.lowestPrices[1].non_stop_only = "true";
        assert.equal(await importStoreJSON(JSON.stringify(exported)), false);

        delete process.env.NONSTOP_ONLY;
        const directResponse = await dashboardGET(new Request("http://localhost/api/dashboard?flyFrom=TYO&flyTo=DLC"));
        const directBody = await directResponse.json();
        assert.equal(directResponse.status, 200);
        assert.equal(directBody.config.nonStopOnly, true);
        assert.equal(directBody.selectedRoute.nonStopOnly, true);
        assert.equal(directBody.latestLowest.min_price, 25000);
        assert.equal(directBody.recentFlights.length, 2);
        assert.equal(directBody.priceHistory[0].min_price, 25000);
        const allBody = await (await dashboardGET(new Request("http://localhost/api/dashboard?flyFrom=TYO&flyTo=DLC&nonStopOnly=false"))).json();
        assert.equal(allBody.selectedRoute.nonStopOnly, false);
        assert.equal(allBody.latestLowest.min_price, 1000);
        assert.equal(allBody.recentFlights.length, 6);
        for (const value of ["1", "TRUE", "", "false&nonStopOnly=true"]) {
          assert.equal((await dashboardGET(new Request(`http://localhost/api/dashboard?nonStopOnly=${value}`))).status, 400);
        }

        const connectingClaim = await claimNotification({ ...flight, raw_data: records[1].raw_data }, "scope@example.test");
        const directClaim = await claimNotification({ ...flight, raw_data: records[5].raw_data }, "scope@example.test");
        assert.ok(connectingClaim && directClaim);
        assert.notEqual(connectingClaim, directClaim);
        assert.equal(await claimNotification({ ...flight, raw_data: records[5].raw_data }, "scope@example.test"), null);
      } finally { process.env.DATA_DIR = previousDir; }
    });

    await t.test("atomic lowest-price comparison shares direct fares with all-flights scope without mixing connecting lows", async () => {
      const previousDir = process.env.DATA_DIR;
      process.env.DATA_DIR = path.join(tempDir, "nonstop-comparison");
      try {
        const { search_run_id: _ignored, ...record } = flight;
        const confirmed = { ...record, price: 30000, raw_data: JSON.stringify({ metadata: { isNonStop: true } }) };
        const first = await persistSearchRun(run, [confirmed]);
        const candidate = { fly_from: "TYO", fly_to: "DLC", min_price: 30000, currency: "JPY", airline: "NH",
          departure_at: flight.departure_at, return_at: flight.return_at, nights_in_dest: 7,
          deep_link: flight.deep_link, flight_record_id: first.flightRecordIds[0], non_stop_only: true };
        assert.deepEqual(await upsertLowestPrice(candidate), { previousLowest: null, isNewLowest: true });
        assert.equal((await getLatestLowestPrice("TYO", "DLC", false))?.min_price, 30000);
        const higher = await persistSearchRun(run, [{ ...record, price: 35000 }]);
        assert.deepEqual(await upsertLowestPrice({ ...candidate, non_stop_only: false, min_price: 35000,
          flight_record_id: higher.flightRecordIds[0] }), { previousLowest: 30000, isNewLowest: false });
        const mixed = await persistSearchRun(run, [{ ...record, price: 15000 }, { ...confirmed, price: 25000 }]);
        assert.deepEqual(await upsertLowestPrice({ ...candidate, non_stop_only: false, min_price: 15000,
          flight_record_id: mixed.flightRecordIds[0] }), { previousLowest: 30000, isNewLowest: true });
        const directAgain = await persistSearchRun(run, [{ ...confirmed, price: 26000 }]);
        assert.deepEqual(await upsertLowestPrice({ ...candidate, min_price: 26000,
          flight_record_id: directAgain.flightRecordIds[0] }), { previousLowest: 25000, isNewLowest: false });
        assert.equal((await getLatestLowestPrice("TYO", "DLC", true))?.min_price, 25000);
        assert.equal((await getLatestLowestPrice("TYO", "DLC", false))?.min_price, 15000);
        // An imported backup may contain caches last updated at different times.
        const unsynchronized = JSON.parse(await exportStoreJSON());
        const anyCache = unsynchronized.lowestPrices.find((row: { non_stop_only?: boolean }) => !row.non_stop_only);
        const directCache = unsynchronized.lowestPrices.find((row: { non_stop_only?: boolean }) => row.non_stop_only);
        anyCache.first_seen_at = "2020-01-01T00:00:00.000Z";
        directCache.first_seen_at = "2021-01-01T00:00:00.000Z";
        directCache.min_price = 10000;
        assert.equal(await importStoreJSON(JSON.stringify(unsynchronized)), true);
        assert.deepEqual(await upsertLowestPrice({ ...candidate, non_stop_only: false, min_price: 12000 }),
          { previousLowest: 10000, isNewLowest: false });
        const synchronized = JSON.parse(await exportStoreJSON());
        const repairedAny = synchronized.lowestPrices.find((row: { non_stop_only?: boolean }) => !row.non_stop_only);
        assert.equal(repairedAny.id, anyCache.id);
        assert.equal(repairedAny.first_seen_at, "2020-01-01T00:00:00.000Z");
        assert.equal(repairedAny.min_price, 10000);
        assert.equal(new Set(synchronized.lowestPrices.map((row: { id: number }) => row.id)).size, 2);
      } finally { process.env.DATA_DIR = previousDir; }
    });

    await t.test("Vercel without durable storage and incomplete credentials never silently save locally", async () => {
      resetEnv();
      process.env.VERCEL = "1";
      process.env.DATA_DIR = path.join(tempDir, "must-not-exist");
      assert.deepEqual(getStorageStatus(), { provider: "unconfigured", configured: false });
      await assert.rejects(insertSearchRun(run), /Persistent storage is not configured/);
      await assert.rejects(fs.stat(process.env.DATA_DIR), { code: "ENOENT" });
      delete process.env.VERCEL;
      process.env.UPSTASH_REDIS_REST_URL = "https://storage.test";
      await assert.rejects(insertSearchRun(run), /both its REST URL and token/);
      process.env.UPSTASH_REDIS_REST_TOKEN = "fake-test-token";
      process.env.UPSTASH_REDIS_REST_URL = "http://storage.test";
      assert.equal(getStorageStatus().configured, false);
      await assert.rejects(getDb(), /HTTPS/);
    });

    await t.test("Redis compare-and-set preserves concurrent inserts and batches a search into two requests", async () => {
      resetEnv();
      process.env.KV_REST_API_URL = "https://storage.test";
      process.env.KV_REST_API_TOKEN = "fake-test-token";
      process.env.FLIGHT_STORAGE_KEY = "test-flight-store";
      const redis = mockRedis();
      globalThis.fetch = redis.fetch;
      assert.deepEqual(getStorageStatus(), { provider: "upstash-redis", configured: true });
      const ids = await Promise.all(Array.from({ length: 12 }, () => insertSearchRun(run)));
      assert.equal(new Set(ids).size, 12);
      assert.equal((await listSearchRuns(100)).length, 12);
      assert.ok(redis.conflicts > 0, "test must exercise conflicting snapshots");
      const beforeCalls = redis.calls;
      const { search_run_id: _ignored, ...record } = flight;
      const result = await persistSearchRun(run, [record, { ...record, fly_to: "PEK" }]);
      assert.equal(redis.calls - beforeCalls, 2);
      assert.equal(result.searchRunId, 13);
      assert.deepEqual(result.flightRecordIds, [1, 2]);
      assert.equal((await listRecentFlights(50, "tyo", "dlc")).length, 1);
      assert.equal((await listRecentFlights(50, "TYO", "PEK"))[0].search_run_id, 13);
      const lowest = { fly_from: "TYO", fly_to: "DLC", min_price: 10000, currency: "JPY", airline: "NH",
        departure_at: flight.departure_at, return_at: flight.return_at, nights_in_dest: 7,
        deep_link: flight.deep_link, flight_record_id: 1 };
      await Promise.all([upsertLowestPrice(lowest), upsertLowestPrice({ ...lowest, min_price: 8000 })]);
      assert.equal((await getLatestLowestPrice("TYO", "DLC"))?.min_price, 8000);
      const concurrentNewLow = await Promise.all([
        upsertLowestPrice({ ...lowest, fly_to: "PEK", min_price: 8000 }),
        upsertLowestPrice({ ...lowest, fly_to: "PEK", min_price: 10000 }),
      ]);
      assert.deepEqual(concurrentNewLow, [
        { previousLowest: null, isNewLowest: true }, { previousLowest: 8000, isNewLowest: false },
      ]);
      const backup = await exportStoreJSON();
      redis.values.set("test-flight-store", { value: "bad" });
      await assert.rejects(getDb(), /Stored flight data is invalid/);
      assert.equal(await importStoreJSON(backup), true);
    });

    await t.test("Redis claims are exclusive, expire, and old releases cannot erase new claims", async () => {
      const redis = mockRedis();
      globalThis.fetch = redis.fetch;
      const claims = await Promise.all(Array.from({ length: 8 }, () => claimNotification(flight, "person@example.test")));
      const first = claims.find((key): key is string => key !== null)!;
      assert.equal(claims.filter(Boolean).length, 1);
      const storedKey = `test-flight-store:notification:${first.split(":")[0]}`;
      const entry = redis.values.get(storedKey)!;
      assert.ok(entry.expires! > Date.now());
      entry.expires = Date.now() - 1;
      const renewed = await claimNotification(flight, "person@example.test");
      assert.ok(renewed);
      assert.notEqual(renewed, first);
      await releaseNotificationClaim(first);
      assert.equal(await claimNotification(flight, "person@example.test"), null);
      await releaseNotificationClaim(renewed!);
      assert.ok(await claimNotification(flight, "person@example.test"));
    });

    await t.test("oversized CAS requests fail explicitly without dropping existing history", async () => {
      const redis = mockRedis();
      globalThis.fetch = redis.fetch;
      const { search_run_id: _ignored, ...record } = flight;
      await persistSearchRun(run, [record]);
      const stored = JSON.parse(redis.read("test-flight-store")!);
      stored.flightRecords[0].raw_data = "x".repeat(5 * 1024 * 1024);
      const large = JSON.stringify(stored);
      redis.values.set("test-flight-store", { value: large });
      const before = redis.calls;
      await assert.rejects(insertSearchRun(run), /too large.*Export a backup/);
      assert.equal(redis.calls - before, 1, "only read; oversized write must not be submitted");
      assert.equal(redis.read("test-flight-store"), large);
    });

    await t.test("CAS conflict retries stop at the total time budget", async () => {
      const now = Date.now;
      let time = now();
      let calls = 0;
      Date.now = () => time;
      globalThis.fetch = async (_input, init) => {
        time += 6000;
        calls++;
        const command = JSON.parse(String(init?.body))[0];
        return new Response(JSON.stringify({ result: command === "GET" ? null : 0 }));
      };
      try {
        await assert.rejects(insertSearchRun(run), /storage is busy/);
        assert.equal(calls, 3);
      } finally { Date.now = now; }
    });

    await t.test("Redis failures reject writes and backup imports instead of reporting success", async () => {
      const redis = mockRedis();
      globalThis.fetch = redis.fetch;
      await insertSearchRun(run);
      const backup = await exportStoreJSON();
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 401 });
      await assert.rejects(insertSearchRun(run), /HTTP 401/);
      await assert.rejects(importStoreJSON(backup), /HTTP 401/);
      globalThis.fetch = async () => new Response(JSON.stringify({ result: { arbitrary: "object" } }));
      await assert.rejects(getDb(), /invalid record/);
      globalThis.fetch = async () => { throw new Error("network unavailable"); };
      await assert.rejects(getDb(), /request failed or timed out/);
    });
  } finally {
    globalThis.fetch = originalFetch;
    resetEnv();
    for (const [key, value] of Object.entries(savedEnv)) if (value !== undefined) process.env[key] = value;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
