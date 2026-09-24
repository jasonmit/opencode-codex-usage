import assert from "node:assert/strict";
import { parse } from "jsonc-parser";
import { addPluginEntry, removePluginEntries } from "#lib/config-edit.js";
import { test } from "./test.ts";

const configPath = "opencode.jsonc";

const pluginPath = "/plugins/codex";

test("config edits ignore commented plugin examples and retain comments", () => {
  const content = `{
  // "plugins": ["/plugins/codex"],
  "plugins": [
    "existing",
    // /plugins/codex
  ]
}\n`;

  const installed = addPluginEntry(content, configPath, pluginPath, "plugins");
  assert.deepEqual(parse(installed), { plugins: ["existing", pluginPath] });
  const uninstalled = removePluginEntries(installed, configPath, pluginPath, "plugins");
  assert.deepEqual(parse(uninstalled), { plugins: ["existing"] });
  assert.ok(uninstalled.includes('// "plugins": ["/plugins/codex"]'));
  assert.ok(uninstalled.includes("// /plugins/codex"));
});

test("config edits add only a root plugins property", () => {
  const content = `// leading 😀 example { "plugins": [] }
{
  "example": "\\"plugins\\": []",
  "nested": { "plugins": ["nested-entry"] }
}\n`;

  const installed = addPluginEntry(content, configPath, pluginPath, "plugins");
  assert.deepEqual(parse(installed), {
    example: '"plugins": []',
    nested: { plugins: ["nested-entry"] },
    plugins: [pluginPath],
  });
  assert.ok(installed.startsWith("// leading 😀"));
});

test("config edits recognize string, tuple, and object entries without duplicating them", () => {
  const entries = [
    pluginPath,
    [pluginPath, { enabled: true }],
    { package: pluginPath, options: {} },
  ];

  for (const property of ["plugin", "plugins"] as const) {
    for (const entry of entries) {
      const content = JSON.stringify({ [property]: ["other", entry] });
      assert.equal(addPluginEntry(content, configPath, pluginPath, property), content);
      assert.deepEqual(parse(removePluginEntries(content, configPath, pluginPath, property)), {
        [property]: ["other"],
      });
    }
  }
});

test("config edits remove every match and preserve unrelated plugin options", () => {
  const other = { package: "other", options: { enabled: true } };

  const content = JSON.stringify({
    plugins: [pluginPath, other, [pluginPath, {}], { package: pluginPath }],
  });

  assert.deepEqual(parse(removePluginEntries(content, configPath, pluginPath, "plugins")), {
    plugins: [other],
  });
});

test("config edits remove sole, first, middle, and final entries from compact arrays", () => {
  for (const { entries, remaining } of [
    { entries: [pluginPath], remaining: [] },
    { entries: [pluginPath, "other"], remaining: ["other"] },
    { entries: ["before", pluginPath, "after"], remaining: ["before", "after"] },
    { entries: ["other", pluginPath], remaining: ["other"] },
  ]) {
    const content = JSON.stringify({ plugins: entries });
    assert.deepEqual(parse(removePluginEntries(content, configPath, pluginPath, "plugins")), {
      plugins: remaining,
    });
  }
});

test("config edits leave unmatched entries untouched", () => {
  const content = '{ "plugins": ["other"] }\n';
  assert.equal(removePluginEntries(content, configPath, pluginPath, "plugins"), content);
});

test("config edits reject invalid JSONC, non-object roots, and non-array plugins", () => {
  const cases = [
    { content: '{"plugins": [], "broken":}', error: /invalid JSONC/ },
    { content: "[]", error: /root must be an object/ },
    { content: '{"plugins": {"not": "an array"}}', error: /must be an array/ },
  ];

  for (const { content, error } of cases) {
    assert.throws(() => addPluginEntry(content, configPath, pluginPath, "plugins"), error);
    assert.throws(() => removePluginEntries(content, configPath, pluginPath, "plugins"), error);
  }
});

test("uninstall reports a missing plugin array instead of guessing a configuration", () => {
  assert.throws(
    () => removePluginEntries("{}", configPath, pluginPath, "plugins"),
    /remove this path manually/,
  );
});
