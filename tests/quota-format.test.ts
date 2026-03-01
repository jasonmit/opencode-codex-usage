import assert from "node:assert/strict"
import test from "node:test"
import {
  durationText,
  extractCompletedUsageFromSse,
  healthLabel,
  parseProbeLine,
  statusState,
} from "../lib/quota-format.js"

test("durationText formats common ranges", () => {
  assert.equal(durationText("59"), "0m")
  assert.equal(durationText("3600"), "1h0m")
  assert.equal(durationText("90061"), "1d1h")
  assert.equal(durationText("abc"), "-")
})

test("healthLabel selects severity by peak usage", () => {
  assert.equal(healthLabel("10", "20"), "OK")
  assert.equal(healthLabel("75", "30"), "WARN")
  assert.equal(healthLabel("10", "95"), "CRITICAL")
  assert.equal(healthLabel("x", "5"), "UNKNOWN")
})

test("extractCompletedUsageFromSse returns completed usage payload", () => {
  const sse = [
    'data: {"type":"response.created"}',
    'data: {"type":"response.completed","response":{"usage":{"total_tokens":42}}}',
    "data: [DONE]",
  ].join("\n")

  assert.deepEqual(extractCompletedUsageFromSse(sse), { total_tokens: 42 })
})

test("parseProbeLine and statusState read compact probe output", () => {
  const line = "status=WARN(200) plan=plus profile=test used=81%/9% reset=1h0m/7d0h probe_tokens=10"
  const parsed = parseProbeLine(line)

  assert.equal(parsed.status, "WARN(200)")
  assert.equal(parsed.used, "81%/9%")
  assert.equal(parsed.reset, "1h0m/7d0h")
  assert.equal(statusState(parsed.status), "WARN")
})
