import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexQuotaToastPlugin,
  isCommandExecutedEvent,
  isCodexUsageCommand,
  isFileWatcherEvent,
  isSessionDeletedEvent,
  isSessionActivityEvent,
  isSessionCreatedEvent,
  isSupportedProbeModel,
  resolveModelFromEventProperties,
} from "../lib/codex-usage-toast-plugin.js";

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

test("matches command executed event type", () => {
  assert.equal(isCommandExecutedEvent("command.executed"), true);
  assert.equal(isCommandExecutedEvent("message.updated"), false);
});

test("matches codex usage command names", () => {
  assert.equal(isCodexUsageCommand("/codex-usage"), true);
  assert.equal(isCodexUsageCommand("codex-usage"), true);
  assert.equal(isCodexUsageCommand("/other"), false);
  assert.equal(isCodexUsageCommand(undefined), false);
});

test("server plugin does not register codex usage as a session command", async () => {
  const plugin = CodexQuotaToastPlugin(pluginContext());
  const config: { command?: Record<string, { description: string; template: string }> } = {};

  await plugin.config?.(config);
  plugin.dispose?.();

  assert.equal(config.command?.["codex-usage"], undefined);
});

test("server plugin does not intercept codex usage session command", async () => {
  const plugin = CodexQuotaToastPlugin(pluginContext());
  const hook = (plugin as Record<string, unknown>)["command.execute.before"];
  plugin.dispose?.();

  assert.equal(hook, undefined);
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
