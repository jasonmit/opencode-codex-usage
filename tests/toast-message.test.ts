import assert from "node:assert/strict";
import test from "node:test";
import { messageFromParsed } from "../codex-quota-toast-plugin.js";

test("labels usage with hourly and weekly windows", () => {
  const message = messageFromParsed({
    status: "WARN(200)",
    used: "81%/9%",
    reset: "1h0m/7d0h",
  });

  assert.equal(message, "Quota WARN | hourly 81% (resets 1h0m) | weekly 9% (resets 7d0h)");
});

test("falls back to placeholders for missing metric values", () => {
  const message = messageFromParsed({
    status: "OK(200)",
    used: "",
    reset: undefined,
  });

  assert.equal(message, "Quota OK | hourly - (resets -) | weekly - (resets -)");
});

test("keeps error-focused toast message unchanged", () => {
  const message = messageFromParsed({
    status: "ERROR(auth)",
    error: "missing access token",
  });

  assert.equal(message, "Quota ERROR | missing access token");
});
