import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { test } from "./test.ts";

const root = path.resolve(import.meta.dirname, "../..");
const cli = path.join(root, "dist/bin/opencode-codex-usage.js");
const serverPlugin = path.join(root, "opencode2-plugin");
const tuiPlugin = path.join(root, "opencode2-tui-plugin");
const configSchema = z.object({
  plugins: z.array(
    z.union([
      z.string(),
      z.object({ package: z.string(), options: z.record(z.string(), z.unknown()) }),
    ]),
  ),
});

const fixture = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-cli-integration-"));
  const configHome = path.join(directory, "config");
  const env = {
    ...process.env,
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: path.join(directory, "data"),
    OPENCODE_AUTH_PATH: "",
  };
  const run = (args: string[], environment = env) =>
    spawnSync(process.execPath, [cli, ...args], {
      env: environment,
      encoding: "utf8",
      cwd: directory,
    });
  return {
    directory,
    configHome,
    env,
    run,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

test("default V2 installation uses XDG_CONFIG_HOME for both plugins", async () => {
  const state = await fixture();
  try {
    const result = state.run(["--install"]);
    assert.equal(result.status, 0, result.stderr);
    const server = JSON.parse(
      await readFile(path.join(state.configHome, "opencode/opencode.jsonc"), "utf8"),
    );
    const tui = JSON.parse(
      await readFile(path.join(state.configHome, "opencode/cli.json"), "utf8"),
    );
    assert.deepEqual(configSchema.parse(server).plugins, [serverPlugin]);
    assert.deepEqual(configSchema.parse(tui).plugins, [tuiPlugin]);
  } finally {
    await state.cleanup();
  }
});

test("default V2 installation falls back to ~/.config/opencode", async () => {
  const state = await fixture();
  try {
    const env = { ...state.env, XDG_CONFIG_HOME: "" };
    const result = state.run(["--install"], env);
    assert.equal(result.status, 0, result.stderr);
    const server = JSON.parse(
      await readFile(path.join(state.directory, ".config/opencode/opencode.jsonc"), "utf8"),
    );
    assert.deepEqual(configSchema.parse(server).plugins, [serverPlugin]);
  } finally {
    await state.cleanup();
  }
});

test("project server config keeps V2 terminal configuration global", async () => {
  const state = await fixture();
  try {
    const config = path.join(state.directory, "project/opencode.jsonc");
    const result = state.run(["--install", "--config", config]);
    assert.equal(result.status, 0, result.stderr);
    const tui = JSON.parse(
      await readFile(path.join(state.configHome, "opencode/cli.json"), "utf8"),
    );
    assert.deepEqual(configSchema.parse(tui).plugins, [tuiPlugin]);
    await assert.rejects(readFile(path.join(state.directory, "project/cli.json")), {
      code: "ENOENT",
    });
    const removed = state.run(["--uninstall", "--config", config]);
    assert.equal(removed.status, 0, removed.stderr);
    const uninstalled = JSON.parse(
      await readFile(path.join(state.configHome, "opencode/cli.json"), "utf8"),
    );
    assert.deepEqual(configSchema.parse(uninstalled).plugins, []);
  } finally {
    await state.cleanup();
  }
});

test("V2 install and uninstall recognize object-form entries without losing other options", async () => {
  const state = await fixture();
  try {
    const config = path.join(state.directory, "opencode.jsonc");
    const other = { package: "other-plugin", options: { enabled: true } };
    await writeFile(
      config,
      JSON.stringify({ plugins: [other, { package: serverPlugin, options: {} }] }),
    );
    const installed = state.run(["--install", "--config", config]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(configSchema.parse(JSON.parse(await readFile(config, "utf8"))).plugins, [
      other,
      { package: serverPlugin, options: {} },
    ]);
    const removed = state.run(["--uninstall", "--config", config]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(configSchema.parse(JSON.parse(await readFile(config, "utf8"))).plugins, [
      other,
    ]);
  } finally {
    await state.cleanup();
  }
});

test("legacy CLI still reads auth from XDG_DATA_HOME (56bf4e0)", async () => {
  const state = await fixture();
  try {
    const auth = path.join(state.env.XDG_DATA_HOME, "opencode/auth.json");
    await mkdir(path.dirname(auth), { recursive: true });
    await writeFile(auth, JSON.stringify({ openai: { accountId: "legacy-account" } }));
    const result = state.run(["--opencode", "1", "--json", "--no-notify"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing access token/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  } finally {
    await state.cleanup();
  }
});

const fakeOpenCode = async (
  state: Awaited<ReturnType<typeof fixture>>,
  response: string,
  exitCode = 0,
) => {
  const bin = path.join(state.directory, "bin");
  const calls = path.join(state.directory, "calls.json");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "opencode"),
    `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));
process.${exitCode ? "stderr" : "stdout"}.write(${JSON.stringify(response)});
process.exitCode = ${exitCode};
`,
    { mode: 0o755 },
  );
  return {
    env: { ...state.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    calls: async () => z.array(z.string()).parse(JSON.parse(await readFile(calls, "utf8"))),
  };
};

test("V2 CLI queries the server RPC without legacy credentials and forwards retry", async () => {
  const state = await fixture();
  try {
    const snapshot = { status: "ok", used: { primary: 23, secondary: 4 } };
    const host = await fakeOpenCode(state, JSON.stringify({ output: snapshot }));
    const result = state.run(["--json", "--no-notify", "--retry", "2"], host.env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), snapshot);
    assert.deepEqual(await host.calls(), [
      "api",
      "post",
      "/api/rpc/opencode-codex-usage/usage",
      "--data",
      '{"input":{"retryCount":2}}',
    ]);
  } finally {
    await state.cleanup();
  }
});

test("V2 CLI formats RPC quota as readable output", async () => {
  const state = await fixture();
  try {
    const host = await fakeOpenCode(
      state,
      JSON.stringify({ output: { status: "ok", used: { primary: 23, secondary: 4 } } }),
    );
    const result = state.run(["--pretty", "--no-notify"], host.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /23%/);
    assert.deepEqual(await host.calls(), [
      "api",
      "post",
      "/api/rpc/opencode-codex-usage/usage",
      "--data",
      '{"input":{}}',
    ]);
  } finally {
    await state.cleanup();
  }
});

test("V2 CLI preserves upstream auth error detail", async () => {
  const state = await fixture();
  try {
    const snapshot = {
      status: "error",
      statusCode: 401,
      error: "Provided authentication token is expired",
    };
    const host = await fakeOpenCode(state, JSON.stringify({ output: snapshot }));
    const result = state.run(["--json", "--no-notify"], host.env);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), snapshot);
    assert.equal(result.stdout, "");
  } finally {
    await state.cleanup();
  }
});

test("V2 CLI reports RPC transport errors without falling back to legacy auth", async () => {
  const state = await fixture();
  try {
    const host = await fakeOpenCode(state, "OpenCode service unavailable", 1);
    const result = state.run(["--json", "--no-notify"], host.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OpenCode service unavailable/);
    assert.doesNotMatch(result.stderr, /auth.json/);
  } finally {
    await state.cleanup();
  }
});

test("V2 CLI rejects malformed RPC output", async () => {
  const state = await fixture();
  try {
    const host = await fakeOpenCode(
      state,
      '{"output":{"status":"ok","used":{"primary":"invalid","secondary":0}}}',
    );
    const result = state.run(["--json", "--no-notify"], host.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid.*quota.*response/i);
    assert.equal(result.stdout, "");
  } finally {
    await state.cleanup();
  }
});
