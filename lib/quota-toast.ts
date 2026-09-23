import { z } from "zod";
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

const PropertyRecordSchema = z.record(z.string(), z.unknown());
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

export const toastBodyFromParsed = (parsed: ProbeDisplaySnapshot, duration: number): ToastBody => {
  const message = messageFromParsed(parsed);
  return {
    title: toastTitleForStatus(parsed.status),
    message,
    variant: toastVariantForStatus(parsed.status),
    duration,
  };
};
