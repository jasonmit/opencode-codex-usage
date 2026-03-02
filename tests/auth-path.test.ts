import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { resolveAuthPath } from "../lib/auth-path.js";

test("uses explicit OPENCODE_AUTH_PATH override", () => {
  const actual = resolveAuthPath({
    platform: "win32",
    env: { OPENCODE_AUTH_PATH: "C:\\custom\\auth.json" },
    homeDir: "C:\\Users\\alice",
  });

  assert.equal(actual, "C:\\custom\\auth.json");
});

test("resolves Windows default from LOCALAPPDATA", () => {
  const actual = resolveAuthPath({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
    homeDir: "C:\\Users\\alice",
  });

  assert.equal(actual, path.join("C:\\Users\\alice\\AppData\\Local", "opencode", "auth.json"));
});

test("resolves macOS default", () => {
  const actual = resolveAuthPath({
    platform: "darwin",
    env: {},
    homeDir: "/Users/alice",
  });

  assert.equal(actual, "/Users/alice/Library/Application Support/opencode/auth.json");
});

test("resolves Linux default with XDG_DATA_HOME", () => {
  const actual = resolveAuthPath({
    platform: "linux",
    env: { XDG_DATA_HOME: "/tmp/xdg-data" },
    homeDir: "/home/alice",
  });

  assert.equal(actual, "/tmp/xdg-data/opencode/auth.json");
});
