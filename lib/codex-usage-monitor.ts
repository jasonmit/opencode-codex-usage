import { statSync } from "node:fs";
import { type ProbeSnapshot } from "./codex-usage-probe.js";
import {
  shouldToastForBackground,
  shouldToastForBackgroundTransition,
  type ToastThreshold,
} from "./quota-policy.js";
import { toastBodyFromParsed, type ToastBody } from "./quota-toast.js";

type RefreshOptions = {
  force?: boolean;
  showFailure?: boolean;
};

type IntervalHandle = ReturnType<typeof globalThis.setInterval> | number;

export type QuotaMonitorOptions = {
  probe: () => Promise<ProbeSnapshot>;
  notify: (toast: ToastBody) => void | Promise<void>;
  logError: (message: string, detail?: string) => void | Promise<void>;
  pollMs: number;
  threshold: ToastThreshold;
  durationMs: number;
  signalPath: string;
  signalWatchMs?: number;
  readSignalRevision?: (path: string) => number;
  setInterval?: (callback: () => void, delay: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
};

export type QuotaMonitor = {
  start(): void;
  stop(options?: { resetStatus?: boolean }): void;
  refresh(options?: RefreshOptions): Promise<void>;
};

const readSignalRevision = (filePath: string): number => {
  try {
    return statSync(filePath, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  } catch {
    return 0;
  }
};

const failureToast = (detail: string, duration: number): ToastBody => ({
  title: "Codex quota 🚨",
  message: `🚨 Quota error | ${detail}`,
  variant: "error",
  duration,
});

export const createQuotaMonitor = (options: QuotaMonitorOptions): QuotaMonitor => {
  const schedule = options.setInterval ?? globalThis.setInterval;
  const unschedule = options.clearInterval ?? globalThis.clearInterval;
  const signalRevision = options.readSignalRevision ?? readSignalRevision;
  const signalWatchMs = options.signalWatchMs ?? 1500;
  let pollTimer: IntervalHandle | undefined;
  let signalTimer: IntervalHandle | undefined;
  let previousStatus: string | undefined;
  let lastSignalRevision = 0;
  let running: Promise<void> | undefined;
  let pendingRefresh = false;
  let pendingForce = false;
  let pendingShowFailure = false;
  let generation = 0;

  const logFailure = async (detail: string): Promise<void> => {
    try {
      await options.logError("quota probe failed", detail);
    } catch {
      // Logging must not break polling.
    }
  };

  const notify = async (toast: ToastBody): Promise<void> => {
    try {
      await options.notify(toast);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      await logFailure(`notification failed: ${detail}`);
    }
  };

  const runOnce = async (
    { force = false, showFailure = false }: RefreshOptions,
    runGeneration: number,
  ): Promise<void> => {
    try {
      const snapshot = await options.probe();
      if (runGeneration !== generation) return;
      const detail = snapshot.error?.trim();
      if (detail) {
        await logFailure(detail);
        if (showFailure) await notify(failureToast(detail, options.durationMs));
        return;
      }

      const shouldNotify =
        force ||
        (shouldToastForBackground(snapshot.status, options.threshold) &&
          shouldToastForBackgroundTransition(snapshot.status, previousStatus));
      previousStatus = snapshot.status;
      if (shouldNotify) await notify(toastBodyFromParsed(snapshot, options.durationMs));
    } catch (error: unknown) {
      if (runGeneration !== generation) return;
      const detail = error instanceof Error ? error.message : String(error);
      await logFailure(detail);
      if (showFailure) await notify(failureToast(detail, options.durationMs));
    }
  };

  const refresh = (request: RefreshOptions = {}): Promise<void> => {
    if (running) {
      pendingRefresh = true;
      pendingForce ||= request.force ?? false;
      pendingShowFailure ||= request.showFailure ?? false;
      return running;
    }

    running = (async () => {
      let current = request;
      do {
        pendingRefresh = false;
        pendingForce = false;
        pendingShowFailure = false;
        await runOnce(current, generation);
        current = { force: pendingForce, showFailure: pendingShowFailure };
      } while (pendingRefresh);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  const refreshSafely = (request: RefreshOptions = {}): void => {
    void refresh(request).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      void logFailure(detail);
    });
  };

  return {
    start() {
      if (pollTimer !== undefined || signalTimer !== undefined) return;
      lastSignalRevision = signalRevision(options.signalPath);
      pollTimer = schedule(() => refreshSafely(), options.pollMs);
      signalTimer = schedule(() => {
        const revision = signalRevision(options.signalPath);
        if (revision <= lastSignalRevision) return;
        lastSignalRevision = revision;
        refreshSafely({ force: true });
      }, signalWatchMs);
      refreshSafely({ force: options.threshold === "always" });
    },
    stop({ resetStatus = true } = {}) {
      generation++;
      pendingRefresh = false;
      pendingForce = false;
      pendingShowFailure = false;
      if (pollTimer !== undefined) unschedule(pollTimer);
      if (signalTimer !== undefined) unschedule(signalTimer);
      pollTimer = undefined;
      signalTimer = undefined;
      if (resetStatus) previousStatus = undefined;
    },
    refresh,
  };
};
