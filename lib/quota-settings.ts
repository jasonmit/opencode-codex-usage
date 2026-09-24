import { z } from "zod";
import { DEFAULT_TOAST_THRESHOLD, TOAST_THRESHOLDS, type ToastThreshold } from "./quota-policy.js";

const DEFAULT_POLL_MS = 10 * 60 * 1000;

// Node coerces larger timer delays to 1ms instead of capping them.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const POLL_MS_ENV = "OPENCODE_CODEX_QUOTA_POLL_MS";

const TOAST_THRESHOLD_ENV = "OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD";

const TOAST_DURATION_MS_ENV = "OPENCODE_CODEX_QUOTA_TOAST_DURATION_MS";

const DEFAULT_TOAST_DURATION_MS = 5000;

const PollMsSchema = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .transform((value) => Number(value))
  .pipe(z.number().int().positive().max(MAX_TIMER_DELAY_MS));

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
