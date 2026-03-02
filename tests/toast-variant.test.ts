import assert from "node:assert/strict";
import test from "node:test";
import { toastVariantForStatus } from "../lib/codex-usage-toast-plugin.js";

test("maps status values to toast variants", () => {
  assert.equal(toastVariantForStatus("ok"), "info");
  assert.equal(toastVariantForStatus("warn"), "warning");
  assert.equal(toastVariantForStatus("critical"), "error");
  assert.equal(toastVariantForStatus("error"), "error");
  assert.equal(toastVariantForStatus("unknown"), "warning");
});

test("treats unrecognized status values as unknown warnings", () => {
  assert.equal(toastVariantForStatus("weird"), "warning");
});
