import assert from "node:assert/strict";
import {
  durationText,
  extractCompletedUsageFromSse,
  healthLabel,
  statusState,
} from "#lib/quota-format.js";
import { test } from "./test.ts";

test("durationText formats common ranges", () => {
  assert.equal(durationText("59"), "0m");
  assert.equal(durationText("3600"), "1h0m");
  assert.equal(durationText("90061"), "1d1h");
  assert.equal(durationText("abc"), "-");
});

test("healthLabel selects severity by peak usage", () => {
  assert.equal(healthLabel("10", "20"), "ok");
  assert.equal(healthLabel("75", "30"), "warn");
  assert.equal(healthLabel("10", "95"), "critical");
  assert.equal(healthLabel("x", "5"), "unknown");
});

test("extractCompletedUsageFromSse returns completed usage payload", () => {
  const sse = [
    'data: {"type":"response.created"}',
    'data: {"type":"response.completed","response":{"usage":{"total_tokens":42}}}',
    "data: [DONE]",
  ].join("\n");

  assert.deepEqual(extractCompletedUsageFromSse(sse), { total_tokens: 42 });
});

test("statusState normalizes status labels", () => {
  assert.equal(statusState("WARN"), "warn");
  assert.equal(statusState("critical (90%)"), "critical");
  assert.equal(statusState(undefined), "unknown");
});
