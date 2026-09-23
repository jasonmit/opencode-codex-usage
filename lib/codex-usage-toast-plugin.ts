import path from "node:path";
import { z } from "zod";
import { createQuotaMonitor } from "./codex-usage-monitor.js";
import { probeQuota, type ProbeSnapshot } from "./codex-usage-probe.js";
import { statusState } from "./quota-format.js";
import { resolveSignalPath } from "./codex-usage-signal.js";

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

const PropertyRecordSchema = z.record(z.string(), z.unknown());
const NonEmptyStringSchema = z.string().trim().min(1);
const TextValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const pairFromText = (raw: string): [string, string] => {
  const normalized = raw.trim();
  if (normalized === "") return ["-", "-"];
  const [left, right] = normalized.split("/", 2);
  return [left?.trim() || "-", right?.trim() || "-"];
};

const textFromUnknown = (value: unknown): string => {
  if (value === null || value === undefined) return "-";
  const parsed = TextValueSchema.safeParse(value);
  if (!parsed.success) return "-";
  const normalized = String(parsed.data).trim();
  return normalized === "" ? "-" : normalized;
};

const stringFromUnknown = (value: unknown): string | undefined => {
  const parsed = z.string().safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const nonEmptyStringFromUnknown = (value: unknown): string | undefined => {
  const parsed = NonEmptyStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const resolveModelFromEventProperties = (
  properties: Record<string, unknown> | undefined,
): string | undefined => {
  if (!properties) return undefined;

  const directModel = nonEmptyStringFromUnknown(properties.model);
  if (directModel) return directModel;

  const directModelName = nonEmptyStringFromUnknown(properties.modelName);
  if (directModelName) return directModelName;

  const directModelId = nonEmptyStringFromUnknown(properties.modelID);
  if (directModelId) return directModelId;

  const info = PropertyRecordSchema.safeParse(properties.info);
  if (info.success) {
    const infoModelId = nonEmptyStringFromUnknown(info.data.modelID);
    if (infoModelId) return infoModelId;

    const infoModel = PropertyRecordSchema.safeParse(info.data.model);
    if (infoModel.success) {
      const nestedModelId = nonEmptyStringFromUnknown(infoModel.data.modelID);
      if (nestedModelId) return nestedModelId;

      const nestedModelName = nonEmptyStringFromUnknown(infoModel.data.modelName);
      if (nestedModelName) return nestedModelName;
    }
  }

  const session = PropertyRecordSchema.safeParse(properties.session);
  if (!session.success) return undefined;
  return (
    nonEmptyStringFromUnknown(session.data.model) ??
    nonEmptyStringFromUnknown(session.data.modelName)
  );
};

const pairFromUnknown = (value: unknown): [string, string] => {
  if (typeof value === "string") return pairFromText(value);

  const record = PropertyRecordSchema.safeParse(value);
  if (record.success) {
    return [
      textFromUnknown(record.data.primary ?? record.data.windowA),
      textFromUnknown(record.data.secondary ?? record.data.windowB),
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

  const record = PropertyRecordSchema.safeParse(value);
  if (record.success) {
    return [
      positiveIntFromUnknown(record.data.primary ?? record.data.windowA),
      positiveIntFromUnknown(record.data.secondary ?? record.data.windowB),
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
    showToast: (payload: ToastPayload) => Promise<void>;
  };
  app?: {
    log: (payload: {
      body: {
        service: string;
        level: "debug" | "info" | "warn" | "error";
        message: string;
        extra?: Record<string, unknown>;
      };
    }) => Promise<void>;
  };
};

type PluginEvent = {
  type: string;
  properties?: Record<string, unknown>;
};

type PluginContext = {
  client: Client;
  worktree: string;
  probeQuota?: typeof probeQuota;
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

export const isSupportedProbeModel = (model: string | undefined): boolean => {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes("codex") || normalized.startsWith("gpt-");
};

type QuotaStatusState = "ok" | "warn" | "critical" | "error" | "unknown";

const STATUS_SEVERITY_RANK = {
  ok: 0,
  unknown: 1,
  warn: 2,
  critical: 3,
  error: 4,
} as const satisfies Record<QuotaStatusState, number>;

const QuotaStatusStateSchema = z.enum(["ok", "warn", "critical", "error", "unknown"]);

const TOAST_VARIANT_BY_STATUS = {
  ok: "info",
  warn: "warning",
  critical: "error",
  error: "error",
  unknown: "warning",
} as const satisfies Record<QuotaStatusState, ToastVariant>;

const statusStateNormalized = (rawStatus: string | undefined): QuotaStatusState => {
  const state = QuotaStatusStateSchema.safeParse(statusState(rawStatus));
  return state.success ? state.data : "unknown";
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

const percentageFromText = (value: string): number | undefined => {
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(normalized)) return undefined;

  const parsed = Number(normalized.replace(/%$/, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const remainingPercentage = (value: string): number | undefined => {
  const used = percentageFromText(value);
  return used === undefined ? undefined : Math.max(0, Math.min(100, 100 - used));
};

const quotaBar = (remaining: number | undefined, width = 8): string => {
  if (remaining === undefined) return "·".repeat(width);

  const filled = Math.round((remaining / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
};

const quotaWindowLabel = (minutes: number | undefined, fallback: string): string => {
  if (minutes === 7 * 24 * 60) return "Weekly limit";
  return `${windowLabelFromMinutes(minutes, fallback).replace(/\s+window$/, "")} limit`;
};

type ProbeDisplaySnapshot = Omit<ProbeSnapshot, "used" | "reset" | "windowMinutes"> & {
  used?: unknown;
  reset?: unknown;
  windowMinutes?: unknown;
};

export const messageFromParsed = (parsed: ProbeDisplaySnapshot): string => {
  const error = parsed.error?.trim();
  if (error) {
    return "quota probe failed";
  }

  const [windowA, windowB] = windowMinutesPairFromUnknown(parsed.windowMinutes);
  const firstWindowLabel = quotaWindowLabel(windowA, "A");
  const secondWindowLabel = quotaWindowLabel(windowB, "B");
  const [usedWindowA, usedWindowB] = pairFromUnknown(parsed.used);
  const [resetWindowA, resetWindowB] = pairFromUnknown(parsed.reset);
  const windows = [
    {
      minutes: windowA,
      label: firstWindowLabel,
      used: usedWindowA,
      reset: resetWindowA,
    },
    {
      minutes: windowB,
      label: secondWindowLabel,
      used: usedWindowB,
      reset: resetWindowB,
    },
  ];
  const visibleWindows = windows.filter(
    ({ minutes, used, reset }) =>
      minutes !== undefined || Number.parseFloat(used) !== 0 || reset !== "0m",
  );
  const labelWidth = Math.max(...visibleWindows.map(({ label }) => label.length));

  return visibleWindows
    .map(({ label, used, reset }) => {
      const remaining = remainingPercentage(used);
      const usage = remaining === undefined ? "- left" : `${Math.round(remaining)}% left`;
      return `${label.padEnd(labelWidth)}  ${quotaBar(remaining)} ${usage.padStart(8)} · resets ${reset}`;
    })
    .join("\n");
};

export const toastBodyFromParsed = (
  parsed: ProbeDisplaySnapshot,
  duration: number,
): ToastPayload["body"] => {
  const message = messageFromParsed(parsed);
  return {
    title: toastTitleForStatus(parsed.status),
    message,
    variant: toastVariantForStatus(parsed.status),
    duration,
  };
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

export const CodexQuotaToastPlugin = (context: PluginContext) => {
  const { client, worktree } = context;
  const quotaProbe = context.probeQuota ?? probeQuota;
  let started = false;
  let sessionModel: string | undefined;
  const signalPath = resolveSignalPath();
  const signalPathNormalized = signalPath.replace(/\\/g, "/");
  const signalBasename = path.posix.basename(signalPathNormalized);

  const isSignalFile = (filePath: string | undefined): boolean => {
    const normalized = (filePath ?? "").replace(/\\/g, "/");
    return (
      normalized === signalPathNormalized ||
      normalized === signalBasename ||
      normalized.endsWith(`/${signalBasename}`)
    );
  };
  const monitor = createQuotaMonitor({
    probe: () => quotaProbe({ model: sessionModel }),
    notify: (body) => client.tui.showToast({ body }),
    logError: async (message, detail) => {
      if (!client.app?.log) return;
      try {
        await client.app.log({
          body: {
            service: "opencode-codex-usage",
            level: "error",
            message,
            extra: { detail, worktree },
          },
        });
      } catch {
        // Avoid recursive logging failures.
      }
    },
    pollMs: resolvePollMs(),
    threshold: resolveToastThreshold(),
    durationMs: resolveToastDurationMs(),
    signalPath,
    signalWatchMs: SIGNAL_WATCH_MS,
  });

  const start = (): void => {
    if (started) return;
    started = true;
    monitor.start();
  };
  const stop = (): void => {
    started = false;
    monitor.stop();
  };
  const restart = (): void => {
    started = false;
    monitor.stop({ resetStatus: false });
    start();
  };

  start();

  return {
    tool: {
      codex_usage: {
        description:
          "Get current Codex quota usage and reset times for the connected ChatGPT account. Use whenever the user asks about Codex usage, ChatGPT usage, remaining quota, limits, or reset times. Does not report OpenAI API billing or general ChatGPT message limits.",
        args: {},
        execute: async (): Promise<string> => {
          return JSON.stringify(await quotaProbe({ model: sessionModel }));
        },
      },
    },
    config: async (_input: {
      command?: Record<
        string,
        {
          description: string;
          template: string;
        }
      >;
    }) => {},
    event: ({ event }: { event: PluginEvent }) => {
      const eventModel = resolveModelFromEventProperties(event.properties);
      if (isSupportedProbeModel(eventModel)) {
        sessionModel = eventModel;
      }

      if (isSessionCreatedEvent(event.type)) {
        restart();
        return;
      }

      if (isSessionActivityEvent(event.type)) {
        start();
        return;
      }

      if (isSessionDeletedEvent(event.type)) {
        sessionModel = undefined;
        stop();
        return;
      }

      if (
        isFileWatcherEvent(event.type) &&
        isSignalFile(
          stringFromUnknown(event.properties?.file) ?? stringFromUnknown(event.properties?.path),
        )
      ) {
        void monitor.refresh({ force: true });
      }
    },
    dispose: () => {
      stop();
    },
  };
};

export default CodexQuotaToastPlugin;
