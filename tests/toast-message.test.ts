import assert from "node:assert/strict";
import { messageFromParsed, toastBodyFromParsed } from "#lib/codex-usage-toast-plugin.js";
import { test } from "./test.ts";

test("labels usage with compact window summary", () => {
  const message = messageFromParsed({
    status: "warn",
    used: { primary: 81, secondary: 9 },
    reset: { primary: "1h0m", secondary: "7d0h" },
    windowMinutes: { primary: 300, secondary: 10080 },
  });

  assert.equal(message, "⏳ 5h: 81% used, reset 1h0m | 7d: 9% used, reset 7d0h");
});

test("omits an empty secondary lane without a window duration", () => {
  const message = messageFromParsed({
    status: "ok",
    used: { primary: 3, secondary: 0 },
    reset: { primary: "6d23h", secondary: "0m" },
    windowMinutes: { primary: 10080, secondary: null },
  });

  assert.equal(message, "⏳ 7d: 3% used, reset 6d23h");
});

test("falls back to compact placeholders for missing metric values", () => {
  const message = messageFromParsed({
    status: "ok",
    used: { primary: null, secondary: null },
    reset: { primary: null, secondary: null },
  });

  assert.equal(message, "⏳ A: - used, reset - | B: - used, reset -");
});

test("falls back to placeholders for non-scalar metric values", () => {
  const malformed = {
    status: "ok",
    used: { primary: { unexpected: true }, secondary: ["unexpected"] },
    reset: { primary: "1h0m", secondary: "2h0m" },
  };

  const message = messageFromParsed(malformed);

  assert.equal(message, "⏳ A: - used, reset 1h0m | B: - used, reset 2h0m");
});

test("falls back to neutral labels when window minutes are missing", () => {
  const message = messageFromParsed({
    status: "warn",
    used: { primary: 81, secondary: 9 },
    reset: { primary: "1h0m", secondary: "7d0h" },
  });

  assert.equal(message, "⏳ A: 81% used, reset 1h0m | B: 9% used, reset 7d0h");
});

test("keeps backward compatibility with legacy pair strings", () => {
  const message = messageFromParsed({
    status: "warn",
    used: "81%/9%",
    reset: "1h0m/7d0h",
  });

  assert.equal(message, "⏳ A: 81% used, reset 1h0m | B: 9% used, reset 7d0h");
});

test("keeps error-focused toast message unchanged", () => {
  const message = messageFromParsed({
    status: "error",
    error: "missing access token",
  });

  assert.equal(message, "quota probe failed");
});

test("puts normal quota details in the toast message for a two-line toast", () => {
  const body = toastBodyFromParsed(
    {
      status: "warn",
      used: { primary: 81, secondary: 9 },
      reset: { primary: "1h0m", secondary: "7d0h" },
      windowMinutes: { primary: 300, secondary: 10080 },
    },
    5000,
  );

  assert.equal(body.title, "Codex quota ⚠️");
  assert.equal(body.message, "⏳ 5h: 81% used, reset 1h0m | 7d: 9% used, reset 7d0h");
  assert.equal(body.variant, "warning");
  assert.equal(body.duration, 5000);
});
