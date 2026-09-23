import path from "node:path";
import { z } from "zod";
import { createQuotaMonitor } from "./codex-usage-monitor.js";
import { probeQuota } from "./codex-usage-probe.js";
import { resolveSignalPath } from "./codex-usage-signal.js";
import { resolvePollMs, resolveToastDurationMs, resolveToastThreshold } from "./quota-settings.js";
import type { ToastBody } from "./quota-toast.js";

const SIGNAL_WATCH_MS = 1500;
const PropertyRecordSchema = z.record(z.string(), z.unknown());
const NonEmptyStringSchema = z.string().trim().min(1);

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

type Client = {
  tui: {
    showToast: (payload: { body: ToastBody }) => Promise<void>;
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

export const isSupportedProbeModel = (model: string | undefined): boolean => {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes("codex") || normalized.startsWith("gpt-");
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
