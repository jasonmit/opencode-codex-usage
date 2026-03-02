import assert from "node:assert/strict";
import test from "node:test";
import {
  isCommandExecutedEvent,
  isCodexUsageCommand,
  isFileWatcherEvent,
  isSessionDeletedEvent,
  isSessionActivityEvent,
  isSessionCreatedEvent,
} from "../lib/codex-usage-toast-plugin.js";

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

test("matches file watcher namespace event types", () => {
  assert.equal(isFileWatcherEvent("file.watcher.updated"), true);
  assert.equal(isFileWatcherEvent("file.watcher.created"), true);
  assert.equal(isFileWatcherEvent("file.edited"), false);
});
