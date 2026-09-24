import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexQuotaTuiPlugin } from "#root/tui.js";
import { test } from "./test.ts";

test("legacy slash command displays the probe auth diagnostic in a toast", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-tui-auth-"));
  const auth = path.join(directory, "auth.json");
  const previousAuth = process.env.OPENCODE_AUTH_PATH;
  const previousDebug = process.env.OPENCODE_CODEX_USAGE_TUI_DEBUG;
  await writeFile(auth, JSON.stringify({ openai: { accountId: "account" } }));
  process.env.OPENCODE_AUTH_PATH = auth;
  delete process.env.OPENCODE_CODEX_USAGE_TUI_DEBUG;

  type Api = Parameters<typeof CodexQuotaTuiPlugin>[0];

  type Toast = Parameters<Api["ui"]["toast"]>[0];

  let onSelect: (() => void) | undefined;
  let dispose: (() => void) | undefined;
  let showToast: (toast: Toast) => void = () => assert.fail("toast promise not initialized");
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const toast = new Promise<Toast>((resolve, reject) => {
    showToast = resolve;
    timeout = setTimeout(
      () => reject(new Error("command did not display an auth error toast")),
      2000,
    );
  });

  try {
    await CodexQuotaTuiPlugin({
      command: {
        register: (commands) => {
          onSelect = commands().find((command) => command.slash.name === "codex-usage")?.onSelect;

          return () => undefined;
        },
      },
      ui: { toast: showToast },
      lifecycle: {
        onDispose: (cleanup) => {
          dispose = cleanup;

          return () => undefined;
        },
      },
    });
    assert.ok(onSelect);
    onSelect();
    const shown = await toast;
    assert.equal(shown.variant, "error");
    assert.match(shown.message, /missing access token/);
  } finally {
    clearTimeout(timeout);
    dispose?.();

    if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_PATH;
    else process.env.OPENCODE_AUTH_PATH = previousAuth;

    if (previousDebug === undefined) delete process.env.OPENCODE_CODEX_USAGE_TUI_DEBUG;
    else process.env.OPENCODE_CODEX_USAGE_TUI_DEBUG = previousDebug;
    await rm(directory, { recursive: true, force: true });
  }
});
