import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeQuota } from "./lib/codex-usage-probe.js";
import { resolveToastDurationMs, toastBodyFromParsed } from "./lib/codex-usage-toast-plugin.js";

type TuiToast = {
  title?: string;
  message: string;
  variant?: "info" | "success" | "warning" | "error";
  duration?: number;
};

type TuiApi = {
  command: {
    register: (
      callback: () => Array<{
        title: string;
        value: string;
        description: string;
        category: string;
        slash: { name: string };
        onSelect: () => void;
      }>,
    ) => () => void;
  };
  ui: {
    toast: (input: TuiToast) => void;
  };
  lifecycle: {
    onDispose: (dispose: () => void) => () => void;
  };
};

const TUI_DEBUG_ENV = "OPENCODE_CODEX_USAGE_TUI_DEBUG";
const debugLogPath = path.join(os.tmpdir(), "opencode-codex-usage-tui-debug.log");

const debugEnabled = (): boolean => {
  const value = process.env[TUI_DEBUG_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
};

const debugLog = (message: string, extra: Record<string, unknown> = {}): void => {
  if (!debugEnabled()) return;
  const line = JSON.stringify({ time: new Date().toISOString(), message, ...extra });
  void appendFile(debugLogPath, `${line}\n`, "utf8").catch(() => undefined);
};

export const CodexQuotaTuiPlugin = async (api: TuiApi): Promise<void> => {
  const toastDurationMs = resolveToastDurationMs();
  let running = false;

  debugLog("tui plugin loaded", {
    hasCommandRegister: typeof api.command?.register,
    hasToast: typeof api.ui?.toast,
  });

  if (debugEnabled()) {
    api.ui.toast({
      title: "Codex usage debug",
      message: `/codex-usage TUI plugin loaded; log: ${debugLogPath}`,
      variant: "info",
      duration: 10_000,
    });
  }

  const showToast = (toast: TuiToast): void => {
    api.ui.toast(toast);
  };

  const runProbe = async (): Promise<void> => {
    debugLog("run probe requested", { running });
    if (running) return;
    running = true;

    try {
      const parsed = await probeQuota();
      const probeError = parsed.error?.trim();
      if (probeError) {
        showToast({
          title: "Codex quota 🚨",
          message: `🚨 Quota error | ${probeError}`,
          variant: "error",
          duration: toastDurationMs,
        });
        return;
      }

      showToast(toastBodyFromParsed(parsed, toastDurationMs));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      showToast({
        title: "Codex quota 🚨",
        message: `🚨 Quota error | ${detail}`,
        variant: "error",
        duration: toastDurationMs,
      });
    } finally {
      running = false;
    }
  };

  const dispose = api.command.register(() => [
    ...(() => {
      const command = {
        title: "Codex usage",
        value: "codex-usage",
        description: "Show Codex quota",
        category: "Codex",
        slash: { name: "codex-usage" },
        onSelect: () => {
          debugLog("command selected");
          void runProbe();
        },
      };
      debugLog("register callback returned command", {
        value: command.value,
        slashName: command.slash.name,
      });
      return [command];
    })(),
  ]);
  debugLog("command registered");

  api.lifecycle.onDispose(() => {
    debugLog("tui plugin disposed");
    dispose();
  });
};

export default { id: "opencode-codex-usage", tui: CodexQuotaTuiPlugin };
