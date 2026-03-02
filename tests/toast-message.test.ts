import assert from "node:assert/strict";
import test from "node:test";
import { messageFromParsed } from "../lib/codex-usage-toast-plugin.js";

test("labels usage with compact window summary", () => {
  const message = messageFromParsed({
    status: "warn",
    used: { primary: 81, secondary: 9 },
    reset: { primary: "1h0m", secondary: "7d0h" },
    windowMinutes: { primary: 300, secondary: 10080 },
  });

  assert.equal(message, "⏳ 5h 81% (reset 1h0m) | 7d 9% (reset 7d0h)");
});

test("falls back to compact placeholders for missing metric values", () => {
  const message = messageFromParsed({
    status: "ok",
    used: { primary: null, secondary: null },
    reset: { primary: null, secondary: null },
  });

  assert.equal(message, "⏳ A - (reset -) | B - (reset -)");
});

test("falls back to neutral labels when window minutes are missing", () => {
  const message = messageFromParsed({
    status: "warn",
    used: { primary: 81, secondary: 9 },
    reset: { primary: "1h0m", secondary: "7d0h" },
  });

  assert.equal(message, "⏳ A 81% (reset 1h0m) | B 9% (reset 7d0h)");
});

test("keeps backward compatibility with legacy pair strings", () => {
  const message = messageFromParsed({
    status: "warn",
    used: "81%/9%",
    reset: "1h0m/7d0h",
  });

  assert.equal(message, "⏳ A 81% (reset 1h0m) | B 9% (reset 7d0h)");
});

test("keeps error-focused toast message unchanged", () => {
  const message = messageFromParsed({
    status: "error",
    error: "missing access token",
  });

  assert.equal(message, "quota probe failed");
});
