import assert from "node:assert/strict";
import test from "node:test";
import TuiPluginModule from "../tui.js";
import { CodexQuotaTuiPlugin } from "../tui.js";

test("tui path plugin exports a stable id", () => {
  assert.equal((TuiPluginModule as Record<string, unknown>).id, "opencode-codex-usage");
});

type RegisteredCommand = {
  title: string;
  value: string;
  description: string;
  category: string;
  slash: { name: string };
  onSelect: () => void;
};

test("tui plugin registers codex usage as a slash command", async () => {
  let commands: RegisteredCommand[] = [];
  const disposers: Array<() => void> = [];
  const api = {
    command: {
      register: (callback: () => RegisteredCommand[]) => {
        commands = callback();
        const dispose = () => undefined;
        disposers.push(dispose);
        return dispose;
      },
    },
    lifecycle: {
      onDispose: (dispose: () => void) => {
        disposers.push(dispose);
        return () => undefined;
      },
    },
    ui: {
      toast: () => undefined,
    },
  };

  await CodexQuotaTuiPlugin(api);

  assert.deepEqual(commands, [
    {
      title: "Codex usage",
      value: "codex-usage",
      description: "Show Codex quota",
      category: "Codex",
      slash: { name: "codex-usage" },
      onSelect: commands[0]?.onSelect,
    },
  ]);
  assert.equal(typeof commands[0]?.onSelect, "function");
});
