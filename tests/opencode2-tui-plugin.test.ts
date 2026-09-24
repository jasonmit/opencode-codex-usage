import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRoot, createSignal } from "solid-js";
import type { Plugin } from "@opencode/plugin/tui";
import { createQuotaMonitor } from "#lib/codex-usage-monitor.js";
import { createOpenCode2TuiPlugin } from "#root/opencode2-tui.js";
import { test } from "./test.ts";

type Route = ReturnType<Plugin.Context["ui"]["router"]["current"]>;

type Listener = Parameters<Plugin.Context["data"]["listen"]>[0];

type RpcResult = {
  status: string;
  statusCode?: number;
  error?: string;
  used?: { primary: number | string; secondary: number };
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const setup = async (eligible: (sessionID: string) => Promise<boolean> = async () => false) => {
  const [route, setRoute] = createSignal<Route>({ type: "home" });
  const [model, setModel] = createSignal({ providerID: "openai", id: "gpt" });
  let claim: Parameters<Plugin.Context["ui"]["slot"]>[0] | undefined;
  let layer: Parameters<Plugin.Context["keymap"]["layer"]>[0] | undefined;
  let listener: Listener | undefined;
  let unmount: () => void = () => undefined;
  let probes = 0;
  let result: RpcResult | Promise<RpcResult> = { status: "ok" };
  let timerID = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const toasts: Array<{ message: string; variant?: string }> = [];
  const locations: Array<{ directory: string } | undefined> = [];

  const plugin = createOpenCode2TuiPlugin(undefined, (options) =>
    createQuotaMonitor({
      ...options,
      setInterval: (callback, delay) => {
        const id = ++timerID;
        timers.set(id, { callback, delay });

        return id;
      },
      clearInterval: (id) => {
        if (typeof id === "number") timers.delete(id);
      },
      readSignalRevision: () => 0,
    }),
  );

  const host = {
    client: {
      rpc: () => ({
        usage: async () => {
          probes++;

          return result;
        },
        pollingEligible: async (
          input: { sessionID: string },
          options?: { location?: { directory: string } },
        ) => {
          locations.push(options?.location);

          return eligible(input.sessionID);
        },
      }),
    },
    data: {
      session: { get: () => ({ model: model(), location: { directory: "/project" } }) },
      listen: (callback: Listener) => {
        listener = callback;

        return () => {
          listener = undefined;
        };
      },
    },
    ui: {
      router: { current: route },
      slot: (input: typeof claim) => {
        claim = input;

        return () => unmount();
      },
      toast: {
        show: (toast: { message: string; variant?: string }) => {
          toasts.push(toast);
        },
      },
    },
    keymap: {
      layer: (input: typeof layer) => {
        layer = input;
      },
    },
  };

  // SAFETY: setup, the app slot, and the command only access the APIs supplied by this host fake.
  const context = host as typeof host & Plugin.Context;
  const cleanup = await plugin.setup(context);

  if (!claim || claim.append !== "app") assert.fail("expected app slot");
  const appClaim = claim;
  createRoot((dispose) => {
    unmount = dispose;
    appClaim.render({});
  });
  await settle();

  return {
    setRoute,
    setModel,
    timers,
    toasts,
    locations,
    unmount,
    probes: () => probes,
    command: () => layer?.().commands?.[0],
    setResult: (value: RpcResult | Promise<RpcResult>) => {
      result = value;
    },
    changed: () =>
      listener?.({
        details: { type: "integration.updated", id: "evt_change", created: 0, data: {} },
      }),
    subscribed: () => listener !== undefined,
    cleanup: async () => {
      await cleanup?.();
    },
  };
};

test("OpenCode 2 local TUI wrapper exposes the required tui.js entrypoint", async () => {
  await access(path.resolve(import.meta.dirname, "../../opencode2-tui-plugin/tui.js"));
});

test("OpenCode 2 pauses automatic probes outside eligible sessions but keeps the manual command", async () => {
  const state = await setup(async (id) => id === "ses_codex");

  try {
    assert.equal(state.probes(), 0, "home must not trigger a startup probe");
    assert.equal(state.timers.size, 0);
    const command = state.command();
    assert.ok(command);
    assert.equal(command.id, "codex_usage");
    assert.equal(command.bind, "ctrl+x u");
    assert.equal(command.slash?.name, "codex-usage");
    assert.equal(command.palette, true);
    await command.run();
    assert.equal(state.probes(), 1);
    assert.equal(state.toasts.length, 1);
    assert.equal(state.timers.size, 0, "manual checks must not enable polling");

    state.setRoute({ type: "session", sessionID: "ses_other" });
    await settle();
    assert.equal(state.probes(), 1);
    await command.run();
    assert.equal(state.probes(), 2);

    state.setRoute({ type: "session", sessionID: "ses_codex" });
    await settle();
    assert.equal(state.probes(), 3);
    assert.equal(state.timers.size, 2);
    assert.deepEqual(state.locations, [{ directory: "/project" }, { directory: "/project" }]);

    for (const timer of state.timers.values()) timer.callback();
    await settle();
    assert.equal(state.probes(), 4);

    state.setRoute({ type: "session", sessionID: "ses_other" });
    await settle();
    assert.equal(state.timers.size, 0);
    assert.equal(state.probes(), 4);
    state.setRoute({ type: "session", sessionID: "ses_codex" });
    await settle();
    assert.equal(state.probes(), 5);
    state.setRoute({ type: "home" });
    await settle();
    assert.equal(state.timers.size, 0);
    assert.equal(state.probes(), 5);
  } finally {
    await state.cleanup();
  }
});

test("OpenCode 2 rechecks polling on selected-model and authentication changes", async () => {
  let allowed = true;
  const state = await setup(async () => allowed);

  try {
    state.setRoute({ type: "session", sessionID: "ses_current" });
    await settle();
    assert.equal(state.probes(), 1);
    allowed = false;
    state.setModel({ providerID: "anthropic", id: "claude" });
    await settle();
    assert.equal(state.timers.size, 0);
    assert.equal(state.probes(), 1);
    allowed = true;
    state.setModel({ providerID: "openai", id: "gpt" });
    await settle();
    assert.equal(state.probes(), 2);
    allowed = false;
    state.changed();
    await settle();
    assert.equal(state.timers.size, 0);
    allowed = true;
    state.changed();
    await settle();
    assert.equal(state.probes(), 3);
    await state.cleanup();
    await state.cleanup();
    assert.equal(state.timers.size, 0);
    assert.equal(state.subscribed(), false);
  } finally {
    await state.cleanup();
  }
});

test("OpenCode 2 records automatic probes and poll timer changes when diagnostics are enabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-poll-diagnostics-"));
  const file = path.join(directory, "poll.log");
  const previous = process.env.OPENCODE_CODEX_QUOTA_DEBUG_FILE;
  process.env.OPENCODE_CODEX_QUOTA_DEBUG_FILE = file;
  let state: Awaited<ReturnType<typeof setup>> | undefined;

  const events = async () =>
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.slice(line.indexOf(" ") + 1));

  try {
    state = await setup(async () => true);
    state.setRoute({ type: "session", sessionID: "ses_codex" });
    await settle();
    assert.deepEqual(await events(), ["poll-timer-started", "automatic-probe-started"]);

    state.setModel({ providerID: "anthropic", id: "claude" });
    await settle();
    assert.equal(state.timers.size, 0);
    assert.deepEqual(await events(), [
      "poll-timer-started",
      "automatic-probe-started",
      "poll-timer-stopped",
    ]);
    await state.command()?.run();
    assert.deepEqual(await events(), [
      "poll-timer-started",
      "automatic-probe-started",
      "poll-timer-stopped",
    ]);
  } finally {
    await state?.cleanup();

    if (previous === undefined) delete process.env.OPENCODE_CODEX_QUOTA_DEBUG_FILE;
    else process.env.OPENCODE_CODEX_QUOTA_DEBUG_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenCode 2 unchanged eligibility preserves timers without another startup probe", async () => {
  const state = await setup(async () => true);

  try {
    state.setRoute({ type: "session", sessionID: "ses_codex" });
    await settle();
    assert.equal(state.probes(), 1);
    const timers = [...state.timers.keys()];
    state.changed();
    await settle();
    state.changed();
    await settle();
    assert.equal(state.probes(), 1);
    assert.deepEqual([...state.timers.keys()], timers);

    for (const timer of state.timers.values()) timer.callback();
    await settle();
    assert.equal(state.probes(), 2);
  } finally {
    await state.cleanup();
  }
});

test("OpenCode 2 manual results survive pausing automatic polling", async () => {
  const state = await setup(async () => true);
  let resolve: (value: { status: string }) => void = () => assert.fail("request not prepared");

  try {
    state.setRoute({ type: "session", sessionID: "ses_codex" });
    await settle();
    state.setResult(
      new Promise<{ status: string }>((done) => {
        resolve = done;
      }),
    );
    const request = state.command()?.run();
    await settle();
    state.setRoute({ type: "home" });
    await settle();
    assert.equal(state.timers.size, 0);
    resolve({ status: "ok" });
    await request;
    assert.equal(state.toasts.length, 1);
  } finally {
    resolve({ status: "ok" });
    await state.cleanup();
  }
});

test("OpenCode 2 plugin disposal still suppresses pending manual results", async () => {
  const state = await setup();
  let resolve: (value: { status: string }) => void = () => assert.fail("request not prepared");

  try {
    state.setResult(
      new Promise<{ status: string }>((done) => {
        resolve = done;
      }),
    );
    const request = state.command()?.run();
    await settle();
    await state.cleanup();
    resolve({ status: "ok" });
    await request;
    assert.equal(state.toasts.length, 0);
  } finally {
    resolve({ status: "ok" });
    await state.cleanup();
  }
});

test("OpenCode 2 ignores late eligibility responses after navigation or disposal", async () => {
  let resolve: (allowed: boolean) => void = () => assert.fail("eligibility not requested");

  const state = await setup(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );

  try {
    state.setRoute({ type: "session", sessionID: "ses_codex" });
    await settle();
    state.setRoute({ type: "home" });
    resolve(true);
    await settle();
    assert.equal(state.probes(), 0);
    assert.equal(state.timers.size, 0);
    state.setRoute({ type: "session", sessionID: "ses_codex" });
    await settle();
    await state.cleanup();
    resolve(true);
    await settle();
    assert.equal(state.probes(), 0);
    assert.equal(state.timers.size, 0);
  } finally {
    await state.cleanup();
  }
});

test("OpenCode 2 eligibility failures pause polling and manual probes still work", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  let fail = false;

  const state = await setup(async () => {
    if (fail) throw new Error("eligibility unavailable");

    return true;
  });

  try {
    state.setRoute({ type: "session", sessionID: "ses_codex" });
    await settle();
    assert.equal(state.probes(), 1);
    fail = true;
    state.changed();
    await settle();
    assert.equal(state.timers.size, 0);
    assert.ok(errors.some((message) => message.includes("eligibility unavailable")));
    await state.command()?.run();
    assert.equal(state.probes(), 2);
    assert.equal(state.toasts.length, 1);
  } finally {
    await state.cleanup();
  }
});

test("OpenCode 2 validates RPC quota snapshots and reports manual failures while paused", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  const state = await setup();

  try {
    state.setResult({ status: "error", statusCode: 401, error: "token expired" });
    await state.command()?.run();
    assert.equal(state.toasts[0]?.variant, "error");
    assert.match(state.toasts[0]?.message ?? "", /token expired/);
    state.setResult({ status: "ok", used: { primary: "invalid", secondary: 0 } });
    await state.command()?.run();
    assert.equal(state.toasts[1]?.variant, "error");
    assert.equal(errors.length, 2);
    assert.equal(state.timers.size, 0);
  } finally {
    await state.cleanup();
  }
});
