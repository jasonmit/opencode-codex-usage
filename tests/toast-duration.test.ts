import assert from "node:assert/strict";
import test from "node:test";
import { resolveToastDurationMs } from "../lib/codex-usage-toast-plugin.js";

test("uses default toast duration when env var is not set", () => {
  assert.equal(resolveToastDurationMs({}, 5000), 5000);
});

test("uses configured toast duration from OPENCODE_CODEX_QUOTA_TOAST_DURATION_MS", () => {
  assert.equal(
    resolveToastDurationMs({ OPENCODE_CODEX_QUOTA_TOAST_DURATION_MS: "7000" }, 5000),
    7000,
  );
});

test("falls back to default toast duration for invalid values", () => {
  assert.equal(
    resolveToastDurationMs({ OPENCODE_CODEX_QUOTA_TOAST_DURATION_MS: "abc" }, 5000),
    5000,
  );
  assert.equal(resolveToastDurationMs({ OPENCODE_CODEX_QUOTA_TOAST_DURATION_MS: "0" }, 5000), 5000);
  assert.equal(
    resolveToastDurationMs({ OPENCODE_CODEX_QUOTA_TOAST_DURATION_MS: "-1" }, 5000),
    5000,
  );
});
