import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createQuotaMonitor } from "./lib/codex-usage-monitor.js";
import { probeQuota } from "./lib/codex-usage-probe.js";
import { resolveSignalPath } from "./lib/codex-usage-signal.js";
import { resolveToastDurationMs } from "./lib/quota-settings.js";

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

const debugLog = (
  message: string,
  extra: {
    hasCommandRegister?: string;
    hasToast?: string;
    detail?: string;
    value?: string;
    slashName?: string;
  } = {},
): void => {
  if (!debugEnabled()) return;
  const line = JSON.stringify({ time: new Date().toISOString(), message, ...extra });
  void appendFile(debugLogPath, `${line}\n`, "utf8").catch(() => undefined);
};

export const CodexQuotaTuiPlugin = async (api: TuiApi): Promise<void> => {
  const toastDurationMs = resolveToastDurationMs();

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

  const monitor = createQuotaMonitor({
    probe: probeQuota,
    notify: (toast) => api.ui.toast(toast),
    logError: (message, detail) => debugLog(message, { detail }),
    pollMs: 10 * 60 * 1000,
    threshold: "never",
    durationMs: toastDurationMs,
    signalPath: resolveSignalPath(),
  });

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
          void monitor.refresh({ force: true, showFailure: true });
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
    monitor.stop();
    dispose();
  });
};

export default { id: "opencode-codex-usage", tui: CodexQuotaTuiPlugin };
