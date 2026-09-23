import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fakeOpenCode, fixture } from "./helpers/cli.js";
import { test } from "./test.ts";

test("legacy CLI still reads auth from XDG_DATA_HOME (56bf4e0)", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const auth = path.join(state.env.XDG_DATA_HOME, "opencode/auth.json");
  await mkdir(path.dirname(auth), { recursive: true });
  await writeFile(auth, JSON.stringify({ openai: { accountId: "legacy-account" } }));
  const result = state.run(["--opencode", "1", "--json", "--no-notify"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing access token/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("V2 CLI queries the server RPC without legacy credentials and forwards retry", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
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
});

test("V2 CLI formats RPC quota as readable output", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
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
});

test("V2 CLI preserves upstream auth error detail", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
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
});

test("V2 CLI reports RPC transport errors without falling back to legacy auth", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const host = await fakeOpenCode(state, "OpenCode service unavailable", 1);
  const result = state.run(["--json", "--no-notify"], host.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OpenCode service unavailable/);
  assert.doesNotMatch(result.stderr, /auth.json/);
});

test("V2 CLI rejects malformed RPC output", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const host = await fakeOpenCode(
    state,
    '{"output":{"status":"ok","used":{"primary":"invalid","secondary":0}}}',
  );
  const result = state.run(["--json", "--no-notify"], host.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid.*quota.*response/i);
  assert.equal(result.stdout, "");
});

test("CLI help succeeds without contacting OpenCode", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const result = state.run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: opencode-codex-usage/);
  assert.match(result.stdout, /--opencode <1\|2>/);
});

test("CLI reports argument errors using the requested output format", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const result = state.run(["--json", "--retry", "invalid"]);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "error",
    statusCode: "local",
    error: "--retry requires an integer between 0 and 2",
  });
  const pretty = state.run(["--pretty", "--retry", "invalid"]);
  assert.equal(pretty.status, 1);
  assert.match(pretty.stderr, /codex quota probe:\s+ERROR/);
});

test("CLI signals a refresh by default and honors --no-notify", async (t) => {
  const state = await fixture();
  t.after(state.cleanup);
  const host = await fakeOpenCode(state, '{"output":{"status":"ok"}}');
  const silent = state.run(["--no-notify"], host.env);
  assert.equal(silent.status, 0, silent.stderr);
  assert.equal(silent.stdout, "");
  await assert.rejects(readFile(state.env.OPENCODE_CODEX_USAGE_SIGNAL_PATH), { code: "ENOENT" });
  const notified = state.run([], host.env);
  assert.equal(notified.status, 0, notified.stderr);
  assert.equal(notified.stdout, "");
  assert.match(await readFile(state.env.OPENCODE_CODEX_USAGE_SIGNAL_PATH, "utf8"), /^\d+\n$/);
});
