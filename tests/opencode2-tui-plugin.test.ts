import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "@opencode/plugin/tui";
import type { QuotaMonitorOptions } from "#lib/codex-usage-monitor.js";
import { createOpenCode2TuiPlugin } from "#root/opencode2-tui.js";
import { test } from "./test.ts";

test("OpenCode 2 local TUI wrapper exposes the required tui.js entrypoint", async () => {
  const wrapper = path.resolve(import.meta.dirname, "../../opencode2-tui-plugin/tui.js");
  await access(wrapper);
});

test("OpenCode 2 TUI plugin registers command, shortcut, toast, and cleanup", async () => {
  let claim: Parameters<Plugin.Context["ui"]["slot"]>[0] | undefined;
  let layer: Parameters<Plugin.Context["keymap"]["layer"]>[0] | undefined;
  let monitorOptions: QuotaMonitorOptions | undefined;
  let starts = 0;
  let stops = 0;
  let unclaims = 0;
  const refreshes: Array<{ force?: boolean; showFailure?: boolean }> = [];
  const toasts: Array<{ message: string }> = [];
  const plugin = createOpenCode2TuiPlugin(
    async () => ({ status: "ok" }),
    (options) => {
      monitorOptions = options;
      return {
        start: () => starts++,
        stop: () => stops++,
        refresh: async (input) => {
          refreshes.push(input ?? {});
        },
      };
    },
  );
  const context = {
    ui: {
      slot: (input: typeof claim) => {
        claim = input;
        return () => {
          unclaims++;
        };
      },
      toast: {
        show: (input: { message: string }) => {
          toasts.push(input);
        },
      },
    },
    keymap: {
      layer: (input: typeof layer) => {
        layer = input;
      },
    },
  } as unknown as Plugin.Context;

  const cleanup = await plugin.setup(context);
  assert.equal(plugin.id, "opencode-codex-usage");
  assert.equal(starts, 1);
  assert.equal(claim?.append, "app");
  claim?.render({});
  const command = layer?.().commands?.[0];
  assert.equal(command?.id, "codex_usage");
  assert.equal(command?.bind, "ctrl+x u");
  assert.equal(command?.slash?.name, "codex-usage");
  assert.equal(command?.palette, true);

  await command?.run();
  assert.deepEqual(refreshes, [{ force: true, showFailure: true }]);
  await monitorOptions?.notify({
    title: "Codex quota",
    message: "fresh quota",
    variant: "info",
    duration: 5000,
  });
  assert.deepEqual(toasts, [
    { title: "Codex quota", message: "fresh quota", variant: "info", duration: 5000 },
  ]);

  await cleanup?.();
  assert.equal(stops, 1);
  assert.equal(unclaims, 1);
});

test("OpenCode 2 TUI probes through the connected server RPC", async () => {
  let monitorOptions: QuotaMonitorOptions | undefined;
  let rpcCalls = 0;
  let rpcResult: unknown = { status: "ok" };
  const plugin = createOpenCode2TuiPlugin(undefined, (options) => {
    monitorOptions = options;
    return {
      start: () => undefined,
      stop: () => undefined,
      refresh: async () => undefined,
    };
  });
  const context = {
    client: {
      rpc: () => ({
        usage: async () => {
          rpcCalls++;
          return rpcResult;
        },
      }),
    },
    ui: {
      slot: () => () => undefined,
      toast: { show: () => undefined },
    },
  } as unknown as Plugin.Context;

  const cleanup = await plugin.setup(context);
  const probe = monitorOptions?.probe;
  if (!probe) assert.fail("expected quota probe");
  assert.deepEqual(await probe(), { status: "ok" });
  assert.equal(rpcCalls, 1);

  rpcResult = { status: "ok", used: { primary: "invalid", secondary: 0 } };
  await assert.rejects(probe);
  await cleanup?.();
});
