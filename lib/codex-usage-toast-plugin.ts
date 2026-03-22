import { statSync } from "node:fs";
import path from "node:path";
import { probeQuota, type ProbeSnapshot } from "./codex-usage-probe.js";
import { statusState } from "./quota-format.js";
import { resolveSignalPath } from "./codex-usage-signal.js";
import { z } from "zod";

const DEFAULT_POLL_MS = 10 * 60 * 1000;
const POLL_MS_ENV = "OPENCODE_CODEX_QUOTA_POLL_MS";
const TOAST_THRESHOLD_ENV = "OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD";
const TOAST_DURATION_MS_ENV = "OPENCODE_CODEX_QUOTA_TOAST_DURATION_MS";
const DEFAULT_TOAST_DURATION_MS = 5000;
const DEFAULT_TOAST_THRESHOLD = "warn";
const SIGNAL_WATCH_MS = 1500;

const TOAST_THRESHOLDS = ["warn", "critical", "error", "always", "never"] as const;

const unitFormatter = {
  minute: new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: "minute",
    unitDisplay: "narrow",
  }),
  hour: new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: "hour",
    unitDisplay: "narrow",
  }),
  day: new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: "day",
    unitDisplay: "narrow",
  }),
} as const;

export type ToastThreshold = (typeof TOAST_THRESHOLDS)[number];

const PollMsSchema = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .transform((value) => Number(value))
  .pipe(z.number().int().positive());

const ToastDurationMsSchema = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .transform((value) => Number(value))
  .pipe(z.number().int().positive());

const ToastThresholdSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(TOAST_THRESHOLDS),
);

const pairFromText = (raw: string): [string, string] => {
  const normalized = raw.trim();
  if (normalized === "") return ["-", "-"];
  const [left, right] = normalized.split("/", 2);
  return [left?.trim() || "-", right?.trim() || "-"];
};

const textFromUnknown = (value: unknown): string => {
  if (value === null || value === undefined) return "-";
  const normalized = String(value).trim();
  return normalized === "" ? "-" : normalized;
};

const stringFromUnknown = (value: unknown): string | undefined => {
  return typeof value === "string" ? value : undefined;
};

const pairFromUnknown = (value: unknown): [string, string] => {
  if (typeof value === "string") return pairFromText(value);

  if (typeof value === "object" && value !== null) {
    const record = value as {
      primary?: unknown;
      secondary?: unknown;
      windowA?: unknown;
      windowB?: unknown;
    };
    return [
      textFromUnknown(record.primary ?? record.windowA),
      textFromUnknown(record.secondary ?? record.windowB),
    ];
  }

  return ["-", "-"];
};

const positiveIntFromUnknown = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return undefined;
    const parsed = Number(normalized);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
};

const windowMinutesPairFromUnknown = (value: unknown): [number | undefined, number | undefined] => {
  if (typeof value === "string") {
    const [left, right] = value.trim() === "" ? ["", ""] : value.split("/", 2);
    return [positiveIntFromUnknown(left ?? ""), positiveIntFromUnknown(right ?? "")];
  }

  if (typeof value === "object" && value !== null) {
    const record = value as {
      primary?: unknown;
      secondary?: unknown;
      windowA?: unknown;
      windowB?: unknown;
    };
    return [
      positiveIntFromUnknown(record.primary ?? record.windowA),
      positiveIntFromUnknown(record.secondary ?? record.windowB),
    ];
  }

  return [undefined, undefined];
};

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
  app?: {
    log: (payload: {
      body: {
        service: string;
        level: "debug" | "info" | "warn" | "error";
        message: string;
        extra?: Record<string, unknown>;
      };
    }) => Promise<unknown>;
  };
};

type PluginEvent = {
  type: string;
  properties?: Record<string, unknown>;
};

type PluginContext = {
  client: Client;
  worktree: string;
};

type ProbeRunResult = {
  failed: boolean;
  detail?: string;
};

export const isCodexUsageCommand = (name: string | undefined): boolean => {
  return name === "/codex-usage" || name === "codex-usage";
};

export const isSessionCreatedEvent = (eventType: string): boolean => {
  return eventType === "session.created";
};

export const isSessionActivityEvent = (eventType: string): boolean => {
  return eventType === "session.updated" || eventType === "session.status";
};

export const isSessionDeletedEvent = (eventType: string): boolean => {
  return eventType === "session.deleted";
};

export const isFileWatcherEvent = (eventType: string): boolean => {
  return eventType.startsWith("file.watcher.");
};

export const isCommandExecutedEvent = (eventType: string): boolean => {
  return eventType === "command.executed";
};

type QuotaStatusState = "ok" | "warn" | "critical" | "error" | "unknown";

const STATUS_SEVERITY_RANK: Record<QuotaStatusState, number> = {
  ok: 0,
  unknown: 1,
  warn: 2,
  critical: 3,
  error: 4,
};

const TOAST_VARIANT_BY_STATUS: Record<QuotaStatusState, ToastVariant> = {
  ok: "info",
  warn: "warning",
  critical: "error",
  error: "error",
  unknown: "warning",
};

const statusStateNormalized = (rawStatus: string | undefined): QuotaStatusState => {
  const state = statusState(rawStatus);
  if (state in STATUS_SEVERITY_RANK) return state as QuotaStatusState;
  return "unknown";
};

export const toastVariantForStatus = (rawStatus: string | undefined): ToastVariant => {
  const state = statusStateNormalized(rawStatus);
  return TOAST_VARIANT_BY_STATUS[state];
};

const emojiForStatus = (rawStatus: string | undefined): string => {
  const state = statusStateNormalized(rawStatus);
  if (state === "ok") return "✅";
  if (state === "warn") return "⚠️";
  if (state === "unknown") return "❓";
  return "🚨";
};

const toastTitleForStatus = (rawStatus: string | undefined): string => {
  const emoji = emojiForStatus(rawStatus);
  return emoji ? `Codex quota ${emoji}` : "Codex quota";
};

export const shouldToastForBackground = (
  rawStatus: string | undefined,
  threshold: ToastThreshold = DEFAULT_TOAST_THRESHOLD,
): boolean => {
  const state = statusStateNormalized(rawStatus);

  if (threshold === "always") return true;
  if (threshold === "never") return false;

  const thresholdRank =
    threshold === "warn"
      ? STATUS_SEVERITY_RANK.warn
      : threshold === "critical"
        ? STATUS_SEVERITY_RANK.critical
        : STATUS_SEVERITY_RANK.error;

  return STATUS_SEVERITY_RANK[state] >= thresholdRank;
};

export const shouldToastForBackgroundTransition = (
  currentStatus: string | undefined,
  previousStatus: string | undefined,
): boolean => {
  const current = statusStateNormalized(currentStatus);
  const previous = previousStatus ? statusStateNormalized(previousStatus) : undefined;
  if (!previous) return true;
  return STATUS_SEVERITY_RANK[current] > STATUS_SEVERITY_RANK[previous];
};

const windowLabelFromMinutes = (minutes: number | undefined, fallback: string): string => {
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) return fallback;

  const dayMinutes = 24 * 60;
  if (minutes % dayMinutes === 0) {
    const days = minutes / dayMinutes;
    return `${unitFormatter.day.format(days)} window`;
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${unitFormatter.hour.format(hours)} window`;
  }

  return `${unitFormatter.minute.format(minutes)} window`;
};

const usageText = (value: string): string => {
  const normalized = value.trim();
  if (normalized === "-") return "-";
  if (normalized.endsWith("%")) return normalized;

  const asNumber = Number.parseFloat(normalized);
  if (!Number.isFinite(asNumber)) return normalized;

  return `${normalized}%`;
};

export const messageFromParsed = (parsed: ProbeSnapshot): string => {
  const error = parsed.error?.trim();
  if (error) {
    return "quota probe failed";
  }

  const [windowA, windowB] = windowMinutesPairFromUnknown(parsed.windowMinutes);
  const firstWindowLabel = windowLabelFromMinutes(windowA, "A").replace(/\s+window$/, "");
  const secondWindowLabel = windowLabelFromMinutes(windowB, "B").replace(/\s+window$/, "");
  const [usedWindowA, usedWindowB] = pairFromUnknown(parsed.used);
  const [resetWindowA, resetWindowB] = pairFromUnknown(parsed.reset);
  const compact = `${firstWindowLabel} ${usageText(usedWindowA)} (reset ${resetWindowA}) | ${secondWindowLabel} ${usageText(usedWindowB)} (reset ${resetWindowB})`;
  return `⏳ ${compact}`;
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

export const resolveToastDurationMs = (
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs = DEFAULT_TOAST_DURATION_MS,
): number => {
  const raw = env[TOAST_DURATION_MS_ENV];
  if (!raw?.trim()) return fallbackMs;

  const parsed = ToastDurationMsSchema.safeParse(raw);
  if (!parsed.success) return fallbackMs;

  return parsed.data;
};

export const CodexQuotaToastPlugin = ({ client, worktree }: PluginContext) => {
  const pollMs = resolvePollMs();
  const toastThreshold = resolveToastThreshold();
  const toastDurationMs = resolveToastDurationMs();
  const forceStartupToast = toastThreshold === "always";

  let running = false;
  let pendingForce = false;
  let started = false;
  let lastBackgroundStatus: QuotaStatusState | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let triggerTimer: ReturnType<typeof setInterval> | undefined;
  const signalPath = resolveSignalPath();
  const signalPathNormalized = signalPath.replace(/\\/g, "/");
  const signalBasename = path.posix.basename(signalPathNormalized);
  let signalRevision = 0;

  const logPluginError = async (message: string, extra: Record<string, unknown>): Promise<void> => {
    if (!client.app?.log) return;

    try {
      await client.app.log({
        body: {
          service: "opencode-codex-usage",
          level: "error",
          message,
          extra,
        },
      });
    } catch {
      // Avoid recursive logging failures.
    }
  };

  const reportAsyncFailure = (scope: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    void logPluginError("plugin async failure", { scope, detail, worktree });
  };

  const triggerStartupProbe = (): void => {
    runProbeSafely({ force: forceStartupToast, showFailureToast: false });
  };

  const isSignalFile = (filePath: string | undefined): boolean => {
    const normalized = (filePath ?? "").replace(/\\/g, "/");
    return (
      normalized === signalPathNormalized ||
      normalized === signalBasename ||
      normalized.endsWith(`/${signalBasename}`)
    );
  };

  const runProbe = async ({
    force = false,
    showFailureToast = false,
  }: { force?: boolean; showFailureToast?: boolean } = {}): Promise<ProbeRunResult> => {
    if (running) {
      if (force) pendingForce = true;
      return { failed: false };
    }

    running = true;

    try {
      const parsed = await probeQuota();
      const probeError = parsed.error?.trim();
      if (probeError) {
        await logPluginError("quota probe failed", { detail: probeError, worktree });
        if (showFailureToast) {
          await client.tui.showToast({
            body: {
              title: "Codex quota 🚨",
              message: `🚨 Quota error | ${probeError}`,
              variant: "error",
              duration: toastDurationMs,
            },
          });
        }
        return { failed: true, detail: probeError };
      }

      const normalizedStatus = statusStateNormalized(parsed.status);
      if (!force) {
        const shouldToastByThreshold = shouldToastForBackground(parsed.status, toastThreshold);
        const shouldToastByTransition = shouldToastForBackgroundTransition(
          normalizedStatus,
          lastBackgroundStatus,
        );
        lastBackgroundStatus = normalizedStatus;
        if (!shouldToastByThreshold || !shouldToastByTransition) {
          return { failed: false };
        }
      } else {
        lastBackgroundStatus = normalizedStatus;
      }

      await client.tui.showToast({
        body: {
          title: toastTitleForStatus(parsed.status),
          message: messageFromParsed(parsed),
          variant: toastVariantForStatus(parsed.status),
          duration: toastDurationMs,
        },
      });
      return { failed: false };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      await logPluginError("quota probe failed", { detail, worktree });
      if (showFailureToast) {
        await client.tui.showToast({
          body: {
            title: "Codex quota 🚨",
            message: `🚨 Quota error | ${detail}`,
            variant: "error",
            duration: toastDurationMs,
          },
        });
      }
      return { failed: true, detail };
    } finally {
      running = false;

      if (pendingForce) {
        pendingForce = false;
        void runProbe({ force: true, showFailureToast: false });
      }
    }
  };

  const runProbeSafely = ({
    force = false,
    showFailureToast = false,
  }: { force?: boolean; showFailureToast?: boolean } = {}): void => {
    runProbe({ force, showFailureToast }).catch((error: unknown) => {
      reportAsyncFailure("runProbe", error);
    });
  };

  const signalMtime = (filePath: string): number => {
    try {
      return statSync(filePath, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    } catch {
      return 0;
    }
  };

  const readSignalRevision = (): number => {
    return signalMtime(signalPath);
  };

  const startSignalWatch = (): void => {
    if (triggerTimer) return;
    signalRevision = readSignalRevision();
    triggerTimer = setInterval(() => {
      const revision = readSignalRevision();
      if (revision <= signalRevision) return;
      signalRevision = revision;
      runProbeSafely({ force: true, showFailureToast: false });
    }, SIGNAL_WATCH_MS);
  };

  const stopSignalWatch = (): void => {
    if (!triggerTimer) return;
    clearInterval(triggerTimer);
    triggerTimer = undefined;
  };

  const startPolling = (): void => {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      runProbeSafely({ showFailureToast: false });
    }, pollMs);
  };

  const startBackgroundWorkers = (): void => {
    startPolling();
    startSignalWatch();
    triggerStartupProbe();
  };

  const stopPolling = (): void => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const stopBackgroundWorkers = (): void => {
    stopPolling();
    stopSignalWatch();
  };

  const restartBackgroundWorkers = (): void => {
    started = true;
    stopBackgroundWorkers();
    startBackgroundWorkers();
  };

  const ensureBackgroundWorkersStarted = (): void => {
    if (started) return;
    started = true;
    startBackgroundWorkers();
  };

  const stopBackgroundWorkersAndReset = (): void => {
    started = false;
    lastBackgroundStatus = undefined;
    stopBackgroundWorkers();
  };

  ensureBackgroundWorkersStarted();

  return {
    config: async (input: {
      command?: Record<
        string,
        {
          description: string;
          template: string;
        }
      >;
    }) => {
      input.command ??= {};
      input.command["codex-usage"] = {
        description: "Show Codex quota",
        template: "",
      };
    },
    "command.execute.before": async (input: { command: string }): Promise<void> => {
      if (!isCodexUsageCommand(input.command)) return;

      const result = await runProbe({ force: true, showFailureToast: true });
      if (result.failed) {
        throw new Error(`opencode-codex-usage: ${result.detail ?? "quota probe failed"}`);
      }
      // We intentionally throw here to stop OpenCode's default command handling.
      // The plugin has already handled /codex-usage (toast shown), so no further execution should occur.
      throw new Error("opencode-codex-usage:handled");
    },
    event: ({ event }: { event: PluginEvent }) => {
      if (isSessionCreatedEvent(event.type)) {
        restartBackgroundWorkers();
        return;
      }

      if (isSessionActivityEvent(event.type)) {
        ensureBackgroundWorkersStarted();
        return;
      }

      if (isSessionDeletedEvent(event.type)) {
        stopBackgroundWorkersAndReset();
        return;
      }

      if (
        isCommandExecutedEvent(event.type) &&
        isCodexUsageCommand(stringFromUnknown(event.properties?.name))
      ) {
        runProbeSafely({ force: true, showFailureToast: true });
        return;
      }

      if (
        isFileWatcherEvent(event.type) &&
        isSignalFile(
          stringFromUnknown(event.properties?.file) ?? stringFromUnknown(event.properties?.path),
        )
      ) {
        runProbeSafely({ force: true, showFailureToast: false });
      }
    },
    dispose: () => {
      stopBackgroundWorkers();
    },
  };
};

export default CodexQuotaToastPlugin;
