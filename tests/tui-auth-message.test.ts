import assert from "node:assert/strict";
import { messageForProbeFailure } from "#root/tui.js";
import { test } from "./test.ts";

test("TUI preserves the probe auth diagnostic", () => {
  const message = messageForProbeFailure({
    status: "error",
    statusCode: "auth",
    error: "missing access token",
  });
  assert.equal(message, "🚨 Quota error | missing access token");
});
