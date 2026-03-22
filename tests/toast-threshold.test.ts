import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveToastThreshold,
  shouldToastForBackground,
  shouldToastForBackgroundTransition,
  type ToastThreshold,
} from "../lib/codex-usage-toast-plugin.js";

test("uses default threshold when env var is not set", () => {
  assert.equal(resolveToastThreshold({}), "warn");
});

test("uses configured threshold from OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD", () => {
  assert.equal(
    resolveToastThreshold({ OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD: "critical" }),
    "critical",
  );
  assert.equal(resolveToastThreshold({ OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD: " ERROR " }), "error");
});

test("falls back to default threshold for invalid values", () => {
  assert.equal(resolveToastThreshold({ OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD: "nope" }), "warn");
  assert.equal(resolveToastThreshold({ OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD: "" }), "warn");
});

test("filters background toasts by threshold", () => {
  const checks: Array<{ threshold: ToastThreshold; status: string; expected: boolean }> = [
    { threshold: "warn", status: "warn", expected: true },
    { threshold: "warn", status: "critical", expected: true },
    { threshold: "warn", status: "ok", expected: false },
    { threshold: "critical", status: "warn", expected: false },
    { threshold: "critical", status: "critical", expected: true },
    { threshold: "critical", status: "error", expected: true },
    { threshold: "error", status: "critical", expected: false },
    { threshold: "error", status: "error", expected: true },
    { threshold: "always", status: "ok", expected: true },
    { threshold: "never", status: "error", expected: false },
  ];

  for (const check of checks) {
    assert.equal(shouldToastForBackground(check.status, check.threshold), check.expected);
  }
});

test("background transition toasts only on worsening status", () => {
  assert.equal(shouldToastForBackgroundTransition("warn", undefined), true);
  assert.equal(shouldToastForBackgroundTransition("warn", "ok"), true);
  assert.equal(shouldToastForBackgroundTransition("critical", "warn"), true);
  assert.equal(shouldToastForBackgroundTransition("error", "critical"), true);
  assert.equal(shouldToastForBackgroundTransition("warn", "warn"), false);
  assert.equal(shouldToastForBackgroundTransition("ok", "warn"), false);
  assert.equal(shouldToastForBackgroundTransition("warn", "critical"), false);
});
