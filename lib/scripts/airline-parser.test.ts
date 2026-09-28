import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { searchSerpapiRoundTripHard } from "../google-flights-api";
import { getAirlineName, unifySerp } from "../search-service";

test("SerpAPI airline parsing through search and normalization", async t => {
  const originalGet = axios.get;
  const fixtures = [
    {
      name: "screenshot: flat OZ connections remain outbound segments",
      flights: [
        { airline: "Asiana Airlines", flight_number: "OZ 1035" },
        { airline: "Asiana Airlines", flight_number: "OZ 377" },
      ],
      expected: "OZ",
      count: 2,
    },
    {
      name: "ANA flight number without airline_code",
      flights: [{ flight_number: "NH903" }],
      expected: "NH",
      count: 1,
    },
    {
      name: "nested arrays preserve mixed carriers",
      flights: [[{ airline_code: "NH" }], [{ airline_code: "CA" }]],
      expected: "NH,CA",
      count: 2,
    },
    {
      name: "nested segment objects",
      flights: [{ segments: [{ flight_number: "OZ 377" }] }],
      expected: "OZ",
      count: 1,
    },
    {
      name: "alphanumeric airline code",
      flights: [{ flight_number: "9C 1234" }],
      expected: "9C",
      count: 1,
    },
    {
      name: "name-only airline is retained without inventing a code",
      flights: [{ airline: "Example Airways" }],
      expected: "Example Airways",
      count: 1,
    },
    {
      name: "missing airline is unknown even with requested NH",
      flights: [{}],
      expected: "?",
      count: 1,
    },
  ];
  try {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        axios.get = (async () => ({
          data: { best_flights: [{ price: 81733, flights: fixture.flights }] },
        })) as typeof axios.get;
        const results = await searchSerpapiRoundTripHard({
          api_key: "fixture-only",
          fromAirports: ["HND"],
          toAirports: ["DLC"],
          searchDaysAhead: 90,
          minNights: 7,
          maxNights: 7,
          maxCalls: 1,
          airlineCodes: ["NH"],
          filterAirlines: false,
        });
        assert.equal(results.length, 1);
        assert.equal(unifySerp(results[0]).airlineCode, fixture.expected);
        assert.equal(results[0].route.length, fixture.count);
        assert.equal(results[0].nightsInDest, 7);
        assert.ok(!results[0].airlines.includes("ALL"));
      });
    }
    await t.test("retry uses the same flat-flight airline parser", async () => {
      let calls = 0;
      axios.get = (async () => {
        if (++calls === 1) throw new Error("timeout");
        return { data: { best_flights: [{ price: 81733, flights: fixtures[0].flights }] } };
      }) as typeof axios.get;
      const results = await searchSerpapiRoundTripHard({
        api_key: "fixture-only", fromAirports: ["HND"], toAirports: ["DLC"],
        searchDaysAhead: 90, minNights: 7, maxNights: 7, maxCalls: 1,
        airlineCodes: ["OZ"], filterAirlines: true,
      });
      assert.equal(calls, 2);
      assert.equal(unifySerp(results[0]).airlineCode, "OZ");
      assert.equal(results[0].route.length, 2);
    });
    await t.test("unknown airline is not accepted by an NH filter", async () => {
      axios.get = (async () => ({
        data: { best_flights: [{ price: 81733, flights: [{}] }] },
      })) as typeof axios.get;
      const results = await searchSerpapiRoundTripHard({
        api_key: "fixture-only", fromAirports: ["HND"], toAirports: ["DLC"],
        searchDaysAhead: 90, minNights: 7, maxNights: 7, maxCalls: 1,
        airlineCodes: ["NH"], filterAirlines: true,
      });
      assert.equal(results.length, 0);
    });
    assert.ok(getAirlineName("OZ").includes("韩亚"));
    assert.ok(getAirlineName("NH,CA").includes("ANA"));
    assert.ok(getAirlineName("NH,CA").includes("中国国航"));
    assert.equal(getAirlineName("ALL"), "航空会社未確認");
  } finally {
    axios.get = originalGet;
  }
});
