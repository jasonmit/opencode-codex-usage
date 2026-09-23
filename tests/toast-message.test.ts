import assert from "node:assert/strict";
import { messageFromParsed, toastBodyFromParsed } from "#lib/quota-toast.js";
import { test } from "./test.ts";

test("renders remaining quota in compact labeled rows", () => {
  const message = messageFromParsed({
    status: "warn",
    used: { primary: 22, secondary: 75 },
    reset: { primary: "2h31m", secondary: "3d15h" },
    windowMinutes: { primary: 300, secondary: 10080 },
  });

  assert.equal(
    message,
    "5h limit      ██████░░ 78% left · resets 2h31m\nWeekly limit  ██░░░░░░ 25% left · resets 3d15h",
  );
});

test("renders exhausted quota as an empty bar with 0% left", () => {
  const message = messageFromParsed({
    status: "critical",
    used: { primary: 100, secondary: 100 },
    reset: { primary: "2h31m", secondary: "3d15h" },
    windowMinutes: { primary: 300, secondary: 10080 },
  });

  assert.equal(
    message,
    "5h limit      ░░░░░░░░  0% left · resets 2h31m\nWeekly limit  ░░░░░░░░  0% left · resets 3d15h",
  );
});

test("renders unused quota as a full bar with 100% left", () => {
  const message = messageFromParsed({
    status: "ok",
    used: { primary: 0, secondary: 0 },
    reset: { primary: "0m", secondary: "0m" },
    windowMinutes: { primary: 300, secondary: 10080 },
  });

  assert.equal(
    message,
    "5h limit      ████████ 100% left · resets 0m\nWeekly limit  ████████ 100% left · resets 0m",
  );
});

test("omits an empty secondary lane without a window duration", () => {
  const message = messageFromParsed({
    status: "ok",
    used: { primary: 3, secondary: 0 },
    reset: { primary: "6d23h", secondary: "0m" },
    windowMinutes: { primary: 10080, secondary: null },
  });

  assert.equal(message, "Weekly limit  ████████ 97% left · resets 6d23h");
});

test("falls back to compact placeholders for missing metric values", () => {
  const message = messageFromParsed({
    status: "ok",
    used: { primary: null, secondary: null },
    reset: { primary: null, secondary: null },
  });

  assert.equal(
    message,
    "A limit  ········   - left · resets -\nB limit  ········   - left · resets -",
  );
});

test("falls back to placeholders for non-scalar metric values", () => {
  const malformed = {
    status: "ok",
    used: { primary: { unexpected: true }, secondary: ["unexpected"] },
    reset: { primary: "1h0m", secondary: "2h0m" },
  };

  const message = messageFromParsed(malformed);

  assert.equal(
    message,
    "A limit  ········   - left · resets 1h0m\nB limit  ········   - left · resets 2h0m",
  );
});

test("falls back to placeholders for malformed percentage strings", () => {
  const message = messageFromParsed({
    status: "ok",
    used: { primary: "81oops", secondary: "9%%" },
    reset: { primary: "1h0m", secondary: "2h0m" },
  });

  assert.equal(
    message,
    "A limit  ········   - left · resets 1h0m\nB limit  ········   - left · resets 2h0m",
  );
});

test("falls back to neutral labels when window minutes are missing", () => {
  const message = messageFromParsed({
    status: "warn",
    used: { primary: 81, secondary: 9 },
    reset: { primary: "1h0m", secondary: "7d0h" },
  });

  assert.equal(
    message,
    "A limit  ██░░░░░░ 19% left · resets 1h0m\nB limit  ███████░ 91% left · resets 7d0h",
  );
});

test("keeps backward compatibility with legacy pair strings", () => {
  const message = messageFromParsed({
    status: "warn",
    used: "81%/9%",
    reset: "1h0m/7d0h",
  });

  assert.equal(
    message,
    "A limit  ██░░░░░░ 19% left · resets 1h0m\nB limit  ███████░ 91% left · resets 7d0h",
  );
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
  assert.equal(
    body.message,
    "5h limit      ██░░░░░░ 19% left · resets 1h0m\nWeekly limit  ███████░ 91% left · resets 7d0h",
  );
  assert.equal(body.variant, "warning");
  assert.equal(body.duration, 5000);
});
