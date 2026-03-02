import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SIGNAL_FILENAME, resolveSignalPath } from "../lib/codex-usage-signal.js";

test("resolveSignalPath uses per-user temp path by default", () => {
  const actual = resolveSignalPath({});
  const expectedPrefix = path.join(os.tmpdir(), `${SIGNAL_FILENAME}-`);
  assert.equal(actual.startsWith(expectedPrefix), true);
});

test("resolveSignalPath honors explicit environment override", () => {
  const actual = resolveSignalPath({ OPENCODE_CODEX_USAGE_SIGNAL_PATH: "./tmp/custom-trigger" });
  assert.equal(actual, path.resolve("./tmp/custom-trigger"));
});
