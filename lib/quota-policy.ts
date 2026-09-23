import { z } from "zod";
import { statusState } from "./quota-format.js";

export const TOAST_THRESHOLDS = ["warn", "critical", "error", "always", "never"] as const;
export const DEFAULT_TOAST_THRESHOLD = "warn";
export type ToastThreshold = (typeof TOAST_THRESHOLDS)[number];

type QuotaStatusState = "ok" | "warn" | "critical" | "error" | "unknown";

const STATUS_SEVERITY_RANK = {
  ok: 0,
  unknown: 1,
  warn: 2,
  critical: 3,
  error: 4,
} as const satisfies Record<QuotaStatusState, number>;

const QuotaStatusStateSchema = z.enum(["ok", "warn", "critical", "error", "unknown"]);

export const statusStateNormalized = (rawStatus: string | undefined): QuotaStatusState => {
  const state = QuotaStatusStateSchema.safeParse(statusState(rawStatus));
  return state.success ? state.data : "unknown";
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
