import assert from "node:assert/strict";
import path from "node:path";
import { resolvePluginInstallPath, resolveTuiConfigPath } from "#lib/plugin-install.js";
import { test } from "./test.ts";

test("resolvePluginInstallPath targets the package root", () => {
  const moduleDir = path.resolve(import.meta.dirname, "../lib");
  assert.equal(resolvePluginInstallPath(moduleDir), path.resolve(moduleDir, "../.."));
});

test("resolveTuiConfigPath targets legacy tui config beside opencode config", () => {
  assert.equal(
    resolveTuiConfigPath("/home/alice/.config/opencode/opencode.jsonc"),
    "/home/alice/.config/opencode/tui.json",
  );
});
