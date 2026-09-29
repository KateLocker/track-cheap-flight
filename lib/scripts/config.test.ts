import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config";

test("an explicitly empty airline setting means all airlines for scheduled searches", () => {
  const previous = process.env.SELECT_AIRLINES;
  try {
    process.env.SELECT_AIRLINES = "";
    assert.deepEqual(loadConfig().search.selectAirlines, []);
    delete process.env.SELECT_AIRLINES;
    assert.deepEqual(loadConfig().search.selectAirlines, ["NH"]);
    process.env.SELECT_AIRLINES = " nh, jl ";
    assert.deepEqual(loadConfig().search.selectAirlines, ["NH", "JL"]);
  } finally {
    if (previous === undefined) delete process.env.SELECT_AIRLINES;
    else process.env.SELECT_AIRLINES = previous;
  }
});

test("scheduled monitoring defaults to non-stop and can explicitly allow connections", () => {
  const previous = process.env.NONSTOP_ONLY;
  try {
    delete process.env.NONSTOP_ONLY;
    assert.equal(loadConfig().search.nonStopOnly, true);
    process.env.NONSTOP_ONLY = "false";
    assert.equal(loadConfig().search.nonStopOnly, false);
    process.env.NONSTOP_ONLY = " true ";
    assert.equal(loadConfig().search.nonStopOnly, true);
  } finally {
    if (previous === undefined) delete process.env.NONSTOP_ONLY;
    else process.env.NONSTOP_ONLY = previous;
  }
});
