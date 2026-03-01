import assert from "node:assert/strict";
import test from "node:test";
import { messageFromParsed } from "../codex-quota-toast-plugin.js";

test("labels usage with duration window names and line breaks", () => {
  const message = messageFromParsed({
    status: "WARN(200)",
    used: "81%/9%",
    reset: "1h0m/7d0h",
    windowMinutes: "300/10080",
  });

  assert.equal(message, "Quota WARN\n5h window 81% (resets 1h0m)\n7d window 9% (resets 7d0h)");
});

test("falls back to placeholders for missing metric values", () => {
  const message = messageFromParsed({
    status: "OK(200)",
    used: "",
    reset: undefined,
  });

  assert.equal(message, "Quota OK\nwindow A - (resets -)\nwindow B - (resets -)");
});

test("falls back to neutral labels when window minutes are missing", () => {
  const message = messageFromParsed({
    status: "WARN(200)",
    used: "81%/9%",
    reset: "1h0m/7d0h",
  });

  assert.equal(message, "Quota WARN\nwindow A 81% (resets 1h0m)\nwindow B 9% (resets 7d0h)");
});

test("keeps error-focused toast message unchanged", () => {
  const message = messageFromParsed({
    status: "ERROR(auth)",
    error: "missing access token",
  });

  assert.equal(message, "Quota ERROR | missing access token");
});
