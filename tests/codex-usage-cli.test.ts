import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCliOptions,
  resolvePluginInstallPath,
  resolveTuiConfigPath,
} from "../lib/codex-usage-cli.js";

test("parseCliOptions uses silent-json defaults", () => {
  assert.deepEqual(parseCliOptions([]), {
    help: false,
    noNotify: false,
    pretty: false,
    printJson: false,
    retryCount: undefined,
    install: false,
    uninstall: false,
    configPath: undefined,
  });
});

test("parseCliOptions recognizes output and notify flags", () => {
  assert.deepEqual(parseCliOptions(["--verbose", "--no-notify"]), {
    help: false,
    noNotify: true,
    pretty: false,
    printJson: true,
    retryCount: undefined,
    install: false,
    uninstall: false,
    configPath: undefined,
  });
  assert.deepEqual(parseCliOptions(["--json"]), {
    help: false,
    noNotify: false,
    pretty: false,
    printJson: true,
    retryCount: undefined,
    install: false,
    uninstall: false,
    configPath: undefined,
  });
});

test("parseCliOptions recognizes pretty output flag", () => {
  assert.deepEqual(parseCliOptions(["--pretty"]), {
    help: false,
    noNotify: false,
    pretty: true,
    printJson: true,
    retryCount: undefined,
    install: false,
    uninstall: false,
    configPath: undefined,
  });
});

test("parseCliOptions recognizes install and setup alias flags", () => {
  assert.deepEqual(parseCliOptions(["--install"]), {
    help: false,
    noNotify: false,
    pretty: false,
    printJson: false,
    retryCount: undefined,
    install: true,
    uninstall: false,
    configPath: undefined,
  });
  assert.deepEqual(parseCliOptions(["--setup"]), {
    help: false,
    noNotify: false,
    pretty: false,
    printJson: false,
    retryCount: undefined,
    install: true,
    uninstall: false,
    configPath: undefined,
  });
});

test("parseCliOptions recognizes uninstall flag", () => {
  assert.deepEqual(parseCliOptions(["--uninstall"]), {
    help: false,
    noNotify: false,
    pretty: false,
    printJson: false,
    retryCount: undefined,
    install: false,
    uninstall: true,
    configPath: undefined,
  });
});

test("parseCliOptions recognizes help flags", () => {
  assert.equal(parseCliOptions(["--help"]).help, true);
  assert.equal(parseCliOptions(["-h"]).help, true);
});

test("parseCliOptions accepts setup config path", () => {
  assert.equal(
    parseCliOptions(["--install", "--config", "./tmp/opencode.jsonc"]).configPath,
    "./tmp/opencode.jsonc",
  );
  assert.equal(
    parseCliOptions(["--uninstall", "--config=/tmp/opencode.jsonc"]).configPath,
    "/tmp/opencode.jsonc",
  );
});

test("parseCliOptions rejects missing config value", () => {
  assert.throws(() => parseCliOptions(["--config"]), /requires a value/);
});

test("parseCliOptions accepts retry count", () => {
  assert.equal(parseCliOptions(["--retry", "2"]).retryCount, 2);
  assert.equal(parseCliOptions(["--retry=0"]).retryCount, 0);
});

test("parseCliOptions rejects invalid retry count", () => {
  assert.throws(() => parseCliOptions(["--retry"]), /requires a value/);
  assert.throws(() => parseCliOptions(["--retry", "abc"]), /integer between 0 and 2/);
  assert.throws(() => parseCliOptions(["--retry", "9"]), /between 0 and 2/);
});

test("parseCliOptions rejects conflicting install and uninstall flags", () => {
  assert.throws(() => parseCliOptions(["--install", "--uninstall"]), /cannot be combined/);
});

test("resolvePluginInstallPath targets package root for server and tui entrypoints", () => {
  const distLibPath = path.join(fileURLToPath(new URL("..", import.meta.url)), "lib");

  assert.equal(resolvePluginInstallPath(distLibPath), path.resolve(distLibPath, "..", ".."));
});

test("resolveTuiConfigPath targets tui config beside opencode config", () => {
  assert.equal(
    resolveTuiConfigPath("/home/alice/.config/opencode/opencode.jsonc"),
    "/home/alice/.config/opencode/tui.json",
  );
});

test("install reports one summary when server and TUI plugins are already configured", async () => {
  const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
  const cliPath = path.join(projectRoot, "dist", "bin", "opencode-codex-usage.js");
  const pluginPath = resolvePluginInstallPath(path.join(projectRoot, "dist", "lib"));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-codex-usage-"));
  const configPath = path.join(tempDir, "opencode.jsonc");
  const config = `${JSON.stringify({ plugin: [pluginPath] }, null, 2)}\n`;

  try {
    await writeFile(configPath, config, "utf8");
    await writeFile(resolveTuiConfigPath(configPath), config, "utf8");

    const stdout = execFileSync(process.execPath, [cliPath, "--install", "--config", configPath], {
      encoding: "utf8",
    });

    assert.equal(stdout, "No changes needed. Server and TUI plugins are already configured.\n");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
