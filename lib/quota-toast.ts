import type { ProbeSnapshot } from "./codex-usage-probe.js";
import { statusStateNormalized } from "./quota-policy.js";

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

type ToastVariant = "info" | "warning" | "error";

export type ToastBody = {
  title: string;
  message: string;
  variant: ToastVariant;
  duration: number;
};

const TOAST_VARIANT_BY_STATUS = {
  ok: "info",
  warn: "warning",
  critical: "error",
  error: "error",
  unknown: "warning",
} as const satisfies Record<ReturnType<typeof statusStateNormalized>, ToastVariant>;

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

const windowLabelFromMinutes = (minutes: number | null | undefined, fallback: string): string => {
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

const remainingPercentage = (used: number | null | undefined): number | undefined => {
  return used === null || used === undefined ? undefined : Math.max(0, Math.min(100, 100 - used));
};

const quotaBar = (remaining: number | undefined, width = 8): string => {
  if (remaining === undefined) return "·".repeat(width);

  const filled = Math.round((remaining / 100) * width);

  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
};

const quotaWindowLabel = (minutes: number | null | undefined, fallback: string): string => {
  if (minutes === 7 * 24 * 60) return "Weekly limit";

  return `${windowLabelFromMinutes(minutes, fallback).replace(/\s+window$/, "")} limit`;
};

export const messageFromParsed = (parsed: ProbeSnapshot): string => {
  const error = parsed.error?.trim();

  if (error) {
    return "quota probe failed";
  }

  const windowA = parsed.windowMinutes?.primary;
  const windowB = parsed.windowMinutes?.secondary;
  const firstWindowLabel = quotaWindowLabel(windowA, "A");
  const secondWindowLabel = quotaWindowLabel(windowB, "B");

  const windows = [
    {
      minutes: windowA,
      label: firstWindowLabel,
      used: parsed.used?.primary,
      reset: parsed.reset?.primary?.trim() || "-",
    },
    {
      minutes: windowB,
      label: secondWindowLabel,
      used: parsed.used?.secondary,
      reset: parsed.reset?.secondary?.trim() || "-",
    },
  ];

  const visibleWindows = windows.filter(
    ({ minutes, used, reset }) =>
      (minutes !== undefined && minutes !== null && Number.isInteger(minutes) && minutes > 0) ||
      used !== 0 ||
      reset !== "0m",
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

export const toastBodyFromParsed = (parsed: ProbeSnapshot, duration: number): ToastBody => {
  const message = messageFromParsed(parsed);

  return {
    title: toastTitleForStatus(parsed.status),
    message,
    variant: toastVariantForStatus(parsed.status),
    duration,
  };
};
