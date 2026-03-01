import { probeQuota, type ProbeSnapshot } from "./codex-quota-probe.js";
import { statusState } from "./lib/quota-format.js";
import { z } from "zod";

const DEFAULT_POLL_MS = 10 * 60 * 1000;
const POLL_MS_ENV = "OPENCODE_CODEX_QUOTA_POLL_MS";
const DEFAULT_TOAST_THRESHOLD = "warn";
const TOAST_THRESHOLD_ENV = "OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD";
const SIGNAL_FILENAME = ".codex-quota-trigger";

const TOAST_THRESHOLDS = ["warn", "critical", "error", "always", "never"] as const;

export type ToastThreshold = (typeof TOAST_THRESHOLDS)[number];

const PollMsSchema = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .transform((value) => Number(value))
  .pipe(z.number().int().positive());

const ToastThresholdSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(TOAST_THRESHOLDS),
);

type ToastVariant = "info" | "warning" | "error";

type ToastPayload = {
  body: {
    title: string;
    message: string;
    variant: ToastVariant;
    duration: number;
  };
};

type Client = {
  tui: {
    showToast: (payload: ToastPayload) => Promise<unknown>;
  };
};

type PluginEvent = {
  type: string;
  properties?: {
    name?: string;
    file?: string;
  };
};

type PluginContext = {
  client: Client;
  worktree: string;
};

const toastVariantForStatus = (rawStatus: string | undefined): ToastVariant => {
  const state = statusState(rawStatus);
  if (state === "ERROR" || state === "CRITICAL") return "error";
  if (state === "WARN" || state === "UNKNOWN") return "warning";
  return "info";
};

export const shouldToastForBackground = (
  rawStatus: string | undefined,
  threshold: ToastThreshold = DEFAULT_TOAST_THRESHOLD,
): boolean => {
  const state = statusState(rawStatus);

  if (threshold === "always") return true;
  if (threshold === "never") return false;
  if (threshold === "error") return state === "ERROR";
  if (threshold === "critical") return state === "CRITICAL" || state === "ERROR";

  return state === "WARN" || state === "CRITICAL" || state === "ERROR";
};

const messageFromParsed = (parsed: ProbeSnapshot): string => {
  const state = statusState(parsed.status);
  if (parsed.error?.trim()) {
    return `Quota ${state} | ${parsed.error}`;
  }

  const used = parsed.used?.trim() ? parsed.used : "-/-";
  const reset = parsed.reset?.trim() ? parsed.reset : "-/-";
  return `Quota ${state} | used ${used} | reset ${reset}`;
};

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

export const resolvePollMs = (
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs = DEFAULT_POLL_MS,
): number => {
  const raw = env[POLL_MS_ENV];
  if (!raw?.trim()) return fallbackMs;

  const parsed = PollMsSchema.safeParse(raw);
  if (!parsed.success) return fallbackMs;

  return parsed.data;
};

export const resolveToastThreshold = (
  env: NodeJS.ProcessEnv = process.env,
  fallback: ToastThreshold = DEFAULT_TOAST_THRESHOLD,
): ToastThreshold => {
  const raw = env[TOAST_THRESHOLD_ENV];
  if (!raw?.trim()) return fallback;

  const parsed = ToastThresholdSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  return fallback;
};

export const CodexQuotaToastPlugin = ({ client, worktree }: PluginContext) => {
  const pollMs = resolvePollMs();
  const toastThreshold = resolveToastThreshold();
  let running = false;
  let pendingForce = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const signalPath = `${worktree.replace(/\/$/, "")}/${SIGNAL_FILENAME}`;

  const isSignalFile = (filePath: string | undefined): boolean => {
    const normalized = (filePath ?? "").replace(/\\/g, "/");
    return (
      normalized === signalPath ||
      normalized === SIGNAL_FILENAME ||
      normalized.endsWith(`/${SIGNAL_FILENAME}`)
    );
  };

  const runProbe = async ({ force = false }: { force?: boolean } = {}): Promise<void> => {
    if (running) {
      if (force) pendingForce = true;
      return;
    }

    running = true;

    try {
      const parsed = await probeQuota();
      if (!force && !shouldToastForBackground(parsed.status, toastThreshold)) {
        return;
      }
      await client.tui.showToast({
        body: {
          title: "Codex quota",
          message: messageFromParsed(parsed),
          variant: toastVariantForStatus(parsed.status),
          duration: 3500,
        },
      });
    } catch (error: unknown) {
      const detail = errorMessage(error).slice(0, 160);
      await client.tui.showToast({
        body: {
          title: "Codex quota",
          message: `Probe failed: ${detail}`,
          variant: "error",
          duration: 4000,
        },
      });
    } finally {
      running = false;

      if (pendingForce) {
        pendingForce = false;
        void runProbe({ force: true });
      }
    }
  };

  const startPolling = (): void => {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      void runProbe();
    }, pollMs);
  };

  const stopPolling = (): void => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  startPolling();

  void runProbe();

  return {
    event: ({ event }: { event: PluginEvent }) => {
      if (event.type === "server.connected") {
        startPolling();
        void runProbe();
      }

      if (event.type === "server.disconnected") {
        stopPolling();
      }

      if (event.type === "command.executed" && event.properties?.name === "codex-quota") {
        void runProbe({ force: true });
      }

      if (event.type === "file.watcher.updated" && isSignalFile(event.properties?.file)) {
        void runProbe();
      }
    },
    dispose: () => {
      stopPolling();
    },
  };
};

export default CodexQuotaToastPlugin;
