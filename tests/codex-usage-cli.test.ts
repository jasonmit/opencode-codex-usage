import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCliOptions,
  resolvePluginInstallPath,
  resolveTuiConfigPath,
} from "#lib/codex-usage-cli.js";
import { test } from "./test.ts";

const parseJsonc = (content: string): unknown => {
  return JSON.parse(
    content
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,\s*([}\]])/g, "$1"),
  );
};

test("parseCliOptions defaults to OpenCode 2", () => {
  assert.equal(parseCliOptions([]).opencodeVersion, 2);
});

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
    opencodeVersion: 2,
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
    opencodeVersion: 2,
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
    opencodeVersion: 2,
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
    opencodeVersion: 2,
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
    opencodeVersion: 2,
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
    opencodeVersion: 2,
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
    opencodeVersion: 2,
  });
});

test("parseCliOptions accepts only explicit OpenCode versions", () => {
  assert.equal(parseCliOptions(["--opencode", "2"]).opencodeVersion, 2);
  assert.equal(parseCliOptions(["--opencode=1"]).opencodeVersion, 1);
  assert.throws(() => parseCliOptions(["--opencode"]), /requires a value/);
  assert.throws(() => parseCliOptions(["--opencode", "3"]), /must be 1 or 2/);
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
  assert.equal(
    resolveTuiConfigPath("/home/alice/.config/opencode2/opencode.jsonc", 2),
    "/home/alice/.config/opencode2/cli.json",
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

    const stdout = execFileSync(
      process.execPath,
      [cliPath, "--install", "--opencode", "1", "--config", configPath],
      { encoding: "utf8" },
    );

    assert.equal(stdout, "No changes needed. Server and TUI plugins are already configured.\n");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OpenCode 1 install and uninstall preserve singular plugin behavior", async () => {
  const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
  const cliPath = path.join(projectRoot, "dist", "bin", "opencode-codex-usage.js");
  const pluginPath = resolvePluginInstallPath(path.join(projectRoot, "dist", "lib"));
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-codex-usage-v1-"));
  const configPath = path.join(tempDir, "opencode.jsonc");
  const tuiConfigPath = resolveTuiConfigPath(configPath);

  try {
    await writeFile(configPath, "{}\n", "utf8");
    execFileSync(process.execPath, [
      cliPath,
      "--install",
      "--opencode",
      "1",
      "--config",
      configPath,
    ]);
    assert.deepEqual(
      (parseJsonc(await readFile(configPath, "utf8")) as { plugin: string[] }).plugin,
      [pluginPath],
    );
    assert.deepEqual(
      (parseJsonc(await readFile(tuiConfigPath, "utf8")) as { plugin: string[] }).plugin,
      [pluginPath],
    );

    execFileSync(process.execPath, [
      cliPath,
      "--uninstall",
      "--opencode",
      "1",
      "--config",
      configPath,
    ]);
    assert.deepEqual(
      (parseJsonc(await readFile(configPath, "utf8")) as { plugin: string[] }).plugin,
      [],
    );
    assert.deepEqual(
      (parseJsonc(await readFile(tuiConfigPath, "utf8")) as { plugin: string[] }).plugin,
      [],
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("default OpenCode 2 install and uninstall use official package entrypoints", async () => {
  const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
  const cliPath = path.join(projectRoot, "dist", "bin", "opencode-codex-usage.js");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-codex-usage-v2-"));
  const configPath = path.join(tempDir, "opencode.jsonc");
  const cliConfigPath = resolveTuiConfigPath(configPath, 2);
  const pluginPath = resolvePluginInstallPath(path.join(projectRoot, "dist", "lib"));
  const serverPlugin = path.join(pluginPath, "opencode2-plugin");
  const tuiPlugin = path.join(pluginPath, "opencode2-tui-plugin");

  try {
    await writeFile(configPath, '{\n  "plugins": ["existing-server"]\n}\n', "utf8");
    await writeFile(cliConfigPath, '{\n  "plugins": ["existing-tui"]\n}\n', "utf8");

    execFileSync(process.execPath, [cliPath, "--install", "--config", configPath], {
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).plugins, [
      "existing-server",
      serverPlugin,
    ]);
    assert.deepEqual(JSON.parse(await readFile(cliConfigPath, "utf8")).plugins, [
      "existing-tui",
      tuiPlugin,
    ]);

    const unchanged = execFileSync(
      process.execPath,
      [cliPath, "--install", "--opencode=2", "--config", configPath],
      { encoding: "utf8" },
    );
    assert.equal(unchanged, "No changes needed. Server and TUI plugins are already configured.\n");

    execFileSync(process.execPath, [cliPath, "--uninstall", "--config", configPath], {
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).plugins, ["existing-server"]);
    assert.deepEqual(JSON.parse(await readFile(cliConfigPath, "utf8")).plugins, ["existing-tui"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OpenCode 2 installer ignores commented plugin examples", async () => {
  const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
  const cliPath = path.join(projectRoot, "dist", "bin", "opencode-codex-usage.js");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-codex-usage-jsonc-"));
  const configPath = path.join(tempDir, "opencode.jsonc");
  const cliConfigPath = resolveTuiConfigPath(configPath, 2);
  const pluginPath = resolvePluginInstallPath(path.join(projectRoot, "dist", "lib"));
  const serverPlugin = path.join(pluginPath, "opencode2-plugin");
  const commented = `{
  // "plugins": [${JSON.stringify(serverPlugin)}],
  "plugins": [
    "existing",
    // ${JSON.stringify(serverPlugin)}
  ]
}\n`;

  try {
    await writeFile(configPath, commented, "utf8");
    await writeFile(cliConfigPath, '{ "plugins": [] }\n', "utf8");
    execFileSync(process.execPath, [
      cliPath,
      "--install",
      "--opencode",
      "2",
      "--config",
      configPath,
    ]);
    assert.deepEqual(
      (parseJsonc(await readFile(configPath, "utf8")) as { plugins: string[] }).plugins,
      ["existing", serverPlugin],
    );

    execFileSync(process.execPath, [
      cliPath,
      "--uninstall",
      "--opencode",
      "2",
      "--config",
      configPath,
    ]);
    const uninstalled = await readFile(configPath, "utf8");
    assert.ok(uninstalled.includes(`// ${JSON.stringify(serverPlugin)}`));
    assert.deepEqual((parseJsonc(uninstalled) as { plugins: string[] }).plugins, ["existing"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OpenCode 2 installer adds only a root plugins property", async () => {
  const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
  const cliPath = path.join(projectRoot, "dist", "bin", "opencode-codex-usage.js");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-codex-usage-root-"));
  const configPath = path.join(tempDir, "opencode.jsonc");
  const cliConfigPath = resolveTuiConfigPath(configPath, 2);
  const pluginPath = resolvePluginInstallPath(path.join(projectRoot, "dist", "lib"));
  const serverPlugin = path.join(pluginPath, "opencode2-plugin");
  const config = `// leading 😀 example { "plugins": [] }
{
  "example": "\\"plugins\\": []",
  "nested": { "plugins": ["nested-entry"] }
}\n`;

  try {
    await writeFile(configPath, config, "utf8");
    await writeFile(cliConfigPath, "{}\n", "utf8");
    execFileSync(process.execPath, [
      cliPath,
      "--install",
      "--opencode",
      "2",
      "--config",
      configPath,
    ]);
    const parsed = parseJsonc(await readFile(configPath, "utf8")) as {
      plugins: string[];
      nested: { plugins: string[] };
    };
    assert.deepEqual(parsed.plugins, [serverPlugin]);
    assert.deepEqual(parsed.nested.plugins, ["nested-entry"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OpenCode 2 installer rejects a non-array root plugins property", async () => {
  const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
  const cliPath = path.join(projectRoot, "dist", "bin", "opencode-codex-usage.js");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-codex-usage-invalid-root-"));
  const configPath = path.join(tempDir, "opencode.jsonc");
  const cliConfigPath = resolveTuiConfigPath(configPath, 2);
  const original = '{\n  "plugins": { "not": "an array" }\n}\n';

  try {
    await writeFile(configPath, original, "utf8");
    await writeFile(cliConfigPath, "{}\n", "utf8");
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [cliPath, "--install", "--opencode", "2", "--config", configPath],
          { stdio: "pipe" },
        ),
      /Command failed/,
    );
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
