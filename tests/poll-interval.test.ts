import assert from "node:assert/strict";
import test from "node:test";
import { resolvePollMs } from "../lib/codex-usage-toast-plugin.js";

test("uses default interval when env var is not set", () => {
  assert.equal(resolvePollMs({}, 600_000), 600_000);
});

test("uses configured poll interval from OPENCODE_CODEX_QUOTA_POLL_MS", () => {
  assert.equal(resolvePollMs({ OPENCODE_CODEX_QUOTA_POLL_MS: "120000" }, 600_000), 120_000);
});

test("falls back to default interval for invalid values", () => {
  assert.equal(resolvePollMs({ OPENCODE_CODEX_QUOTA_POLL_MS: "abc" }, 600_000), 600_000);
  assert.equal(resolvePollMs({ OPENCODE_CODEX_QUOTA_POLL_MS: "0" }, 600_000), 600_000);
  assert.equal(resolvePollMs({ OPENCODE_CODEX_QUOTA_POLL_MS: "-1" }, 600_000), 600_000);
});
