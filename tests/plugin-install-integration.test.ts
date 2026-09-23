import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, root, serverPlugin, tuiPlugin } from "./helpers/cli.js";
import { test } from "./test.ts";

test("default V2 installation uses XDG_CONFIG_HOME for both plugins", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const result = state.run(["--install"]);
  assert.equal(result.status, 0, result.stderr);
  const server = JSON.parse(
    await readFile(path.join(state.configHome, "opencode/opencode.jsonc"), "utf8"),
  );
  const tui = JSON.parse(await readFile(path.join(state.configHome, "opencode/cli.json"), "utf8"));
  assert.deepEqual(server, { plugins: [serverPlugin] });
  assert.deepEqual(tui, { plugins: [tuiPlugin] });
});

test("default V2 installation falls back to ~/.config/opencode", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const result = state.run(["--install"], { ...state.env, XDG_CONFIG_HOME: "" });
  assert.equal(result.status, 0, result.stderr);
  const server = JSON.parse(
    await readFile(path.join(state.directory, ".config/opencode/opencode.jsonc"), "utf8"),
  );
  assert.deepEqual(server, { plugins: [serverPlugin] });
});

test("project server config keeps V2 terminal configuration global", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const config = path.join(state.directory, "project/opencode.jsonc");
  const result = state.run(["--install", "--config", config]);
  assert.equal(result.status, 0, result.stderr);
  const tuiPath = path.join(state.configHome, "opencode/cli.json");
  assert.deepEqual(JSON.parse(await readFile(tuiPath, "utf8")), { plugins: [tuiPlugin] });
  await assert.rejects(readFile(path.join(state.directory, "project/cli.json")), {
    code: "ENOENT",
  });
  const removed = state.run(["--uninstall", "--config", config]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(await readFile(tuiPath, "utf8")), { plugins: [] });
});

test("V2 installation is idempotent and uninstall preserves unrelated options", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const config = path.join(state.directory, "opencode.jsonc");
  const tuiConfig = path.join(state.configHome, "opencode/cli.json");
  const other = { package: "other-plugin", options: { enabled: true } };
  await mkdir(path.dirname(tuiConfig), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({ plugins: [other, { package: serverPlugin, options: {} }] }),
  );
  await writeFile(tuiConfig, JSON.stringify({ plugins: ["existing-tui"] }));
  const installed = state.run(["--install", "--config", config]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), {
    plugins: [other, { package: serverPlugin, options: {} }],
  });
  assert.deepEqual(JSON.parse(await readFile(tuiConfig, "utf8")), {
    plugins: ["existing-tui", tuiPlugin],
  });
  const unchanged = state.run(["--install", "--opencode=2", "--config", config]);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(
    unchanged.stdout,
    "No changes needed. Server and TUI plugins are already configured.\n",
  );
  const removed = state.run(["--uninstall", "--config", config]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { plugins: [other] });
  assert.deepEqual(JSON.parse(await readFile(tuiConfig, "utf8")), { plugins: ["existing-tui"] });
});

test("V1 install and uninstall preserve singular plugin behavior and idempotence", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const config = path.join(state.directory, "opencode.jsonc");
  const tuiConfig = path.join(state.directory, "tui.json");
  await writeFile(config, '{"plugin":["other"]}');
  const args = ["--opencode", "1", "--config", config];
  const installed = state.run(["--install", ...args]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { plugin: ["other", root] });
  assert.deepEqual(JSON.parse(await readFile(tuiConfig, "utf8")), { plugin: [root] });
  const unchanged = state.run(["--install", ...args]);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(
    unchanged.stdout,
    "No changes needed. Server and TUI plugins are already configured.\n",
  );
  const removed = state.run(["--uninstall", ...args]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { plugin: ["other"] });
  assert.deepEqual(JSON.parse(await readFile(tuiConfig, "utf8")), { plugin: [] });
});

test("installer rejects invalid configuration without modifying it", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const config = path.join(state.directory, "opencode.jsonc");
  for (const original of ['{"plugins": {"not": "an array"}}', '{"plugins": [], "broken":}']) {
    await writeFile(config, original);
    const result = state.run(["--install", "--config", config]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not safely update/);
    assert.equal(await readFile(config, "utf8"), original);
  }
});

test("preparing both edits preserves plugins when --config targets the terminal config", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const config = path.join(state.configHome, "opencode/cli.json");
  const installed = state.run(["--install", "--config", config]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), {
    plugins: [serverPlugin, tuiPlugin],
  });
  const removed = state.run(["--uninstall", "--config", config]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { plugins: [] });
});

for (const version of [1, 2] as const) {
  test(`V${version} install validates terminal config before changing server config`, async (t) => {
    const state = await fixture();
    t.after(state.cleanup);
    const config = path.join(state.directory, "project/opencode.jsonc");
    const tuiConfig =
      version === 1
        ? path.join(state.directory, "project/tui.json")
        : path.join(state.configHome, "opencode/cli.json");
    const property = version === 1 ? "plugin" : "plugins";
    await mkdir(path.dirname(tuiConfig), { recursive: true });
    const args = ["--install", "--opencode", String(version), "--config", config];

    for (const invalid of ['{"broken":}', JSON.stringify({ [property]: {} })]) {
      await writeFile(tuiConfig, invalid);
      const result = state.run(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /could not safely update/);
      assert.equal(result.stdout, "");
      await assert.rejects(readFile(config), { code: "ENOENT" });
      assert.equal(await readFile(tuiConfig, "utf8"), invalid);
    }

    await mkdir(path.dirname(config), { recursive: true });
    const original = `// server settings\n${JSON.stringify({ [property]: ["other"] })}\n`;
    await writeFile(config, original);
    const result = state.run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(config, "utf8"), original);
  });

  test(`V${version} uninstall validates terminal config before changing server config`, async (t) => {
    const state = await fixture();
    t.after(state.cleanup);
    const config = path.join(state.directory, "opencode.jsonc");
    const tuiConfig =
      version === 1
        ? path.join(state.directory, "tui.json")
        : path.join(state.configHome, "opencode/cli.json");
    const property = version === 1 ? "plugin" : "plugins";
    const original = JSON.stringify({ [property]: ["other", version === 1 ? root : serverPlugin] });
    await writeFile(config, original);
    await mkdir(path.dirname(tuiConfig), { recursive: true });

    for (const invalid of ['{"broken":}', JSON.stringify({ [property]: {} })]) {
      await writeFile(tuiConfig, invalid);
      const result = state.run(["--uninstall", "--opencode", String(version), "--config", config]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /could not safely update/);
      assert.equal(result.stdout, "");
      assert.equal(await readFile(config, "utf8"), original);
      assert.equal(await readFile(tuiConfig, "utf8"), invalid);
    }
  });
}
