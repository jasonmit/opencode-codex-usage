import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveToastThreshold,
  shouldToastForBackground,
  type ToastThreshold,
} from "../codex-quota-toast-plugin.js";

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
    { threshold: "warn", status: "WARN(200)", expected: true },
    { threshold: "warn", status: "CRITICAL(200)", expected: true },
    { threshold: "warn", status: "OK(200)", expected: false },
    { threshold: "critical", status: "WARN(200)", expected: false },
    { threshold: "critical", status: "CRITICAL(200)", expected: true },
    { threshold: "critical", status: "ERROR(500)", expected: true },
    { threshold: "error", status: "CRITICAL(200)", expected: false },
    { threshold: "error", status: "ERROR(auth)", expected: true },
    { threshold: "always", status: "OK(200)", expected: true },
    { threshold: "never", status: "ERROR(auth)", expected: false },
  ];

  for (const check of checks) {
    assert.equal(shouldToastForBackground(check.status, check.threshold), check.expected);
  }
});
