import assert from "node:assert/strict";
import { z } from "zod";
import {
  CodexQuotaToastPlugin,
  isFileWatcherEvent,
  isSessionDeletedEvent,
  isSessionActivityEvent,
  isSessionCreatedEvent,
  isSupportedProbeModel,
  resolveModelFromEventProperties,
} from "#lib/codex-usage-toast-plugin.js";
import { test } from "./test.ts";

const pluginContext = () => ({
  worktree: "/tmp/worktree",
  client: {
    tui: {
      showToast: async () => undefined,
    },
    app: {
      log: async () => undefined,
    },
  },
});

test("matches observed session lifecycle event types", () => {
  assert.equal(isSessionCreatedEvent("session.created"), true);
  assert.equal(isSessionCreatedEvent("session.updated"), false);

  assert.equal(isSessionActivityEvent("session.updated"), true);
  assert.equal(isSessionActivityEvent("session.status"), true);
  assert.equal(isSessionActivityEvent("server.connected"), false);
});

test("matches documented session deletion event type", () => {
  assert.equal(isSessionDeletedEvent("session.deleted"), true);
  assert.equal(isSessionDeletedEvent("server.instance.disposed"), false);
});

test("server plugin does not intercept codex usage session command", async () => {
  const plugin = CodexQuotaToastPlugin(pluginContext());
  const hasHook = "command.execute.before" in plugin;
  plugin.dispose?.();

  assert.equal(hasHook, false);
});

test("server plugin exposes current Codex quota to the agent", async (testContext) => {
  const snapshot = {
    status: "warn",
    statusCode: 200,
    plan: "plus",
    profile: "default",
    used: { primary: 81, secondary: 9 },
    reset: { primary: "1h0m", secondary: "7d0h" },
    windowMinutes: { primary: 300, secondary: 10080 },
    probeTokens: 10,
  };

  const context = {
    ...pluginContext(),
    probeQuota: async () => snapshot,
  };

  const plugin = CodexQuotaToastPlugin(context);
  testContext.after(() => plugin.dispose?.());

  const AgentToolPluginSchema = z.object({
    tool: z.object({
      codex_usage: z.object({
        description: z.string(),
        execute: z.custom<(args: Record<string, never>) => Promise<string>>(
          (value) => typeof value === "function",
        ),
      }),
    }),
  });

  const parsedPlugin = AgentToolPluginSchema.parse(plugin);
  assert.match(parsedPlugin.tool.codex_usage.description, /use whenever.*ChatGPT usage/i);
  const output = await parsedPlugin.tool.codex_usage.execute({});

  assert.deepEqual(JSON.parse(output), snapshot);
});

test("matches file watcher namespace event types", () => {
  assert.equal(isFileWatcherEvent("file.watcher.updated"), true);
  assert.equal(isFileWatcherEvent("file.watcher.created"), true);
  assert.equal(isFileWatcherEvent("file.edited"), false);
});

test("extracts model from common session event property shapes", () => {
  assert.equal(resolveModelFromEventProperties({ model: "gpt-5.3-codex" }), "gpt-5.3-codex");
  assert.equal(resolveModelFromEventProperties({ modelName: "gpt-codex" }), "gpt-codex");
  assert.equal(
    resolveModelFromEventProperties({
      session: { model: "gpt-5.3-codex" },
    }),
    "gpt-5.3-codex",
  );
  assert.equal(
    resolveModelFromEventProperties({
      session: { modelName: "gpt-codex" },
    }),
    "gpt-codex",
  );
});

test("ignores empty or non-string model values in event properties", () => {
  assert.equal(resolveModelFromEventProperties(undefined), undefined);
  assert.equal(resolveModelFromEventProperties({ model: "   " }), undefined);
  assert.equal(resolveModelFromEventProperties({ model: 123 }), undefined);
  assert.equal(resolveModelFromEventProperties({ session: { model: "" } }), undefined);
});

test("extracts modelID from message.updated user-message shape", () => {
  assert.equal(
    resolveModelFromEventProperties({
      info: {
        role: "user",
        model: { providerID: "openai", modelID: "gpt-5.3-codex" },
      },
    }),
    "gpt-5.3-codex",
  );
});

test("extracts modelID from message.updated assistant-message shape", () => {
  assert.equal(
    resolveModelFromEventProperties({
      info: {
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.3-codex",
      },
    }),
    "gpt-5.3-codex",
  );
});

test("accepts codex and gpt models for quota probes", () => {
  assert.equal(isSupportedProbeModel("gpt-5.3-codex"), true);
  assert.equal(isSupportedProbeModel("gpt-4.1"), true);
  assert.equal(isSupportedProbeModel("gpt-5"), true);
});

test("rejects non-codex and non-gpt models for quota probes", () => {
  assert.equal(isSupportedProbeModel("claude-sonnet-4"), false);
  assert.equal(isSupportedProbeModel("llama"), false);
  assert.equal(isSupportedProbeModel(""), false);
  assert.equal(isSupportedProbeModel("   "), false);
});
