import { z } from "zod";

export type ProbeUsage = {
  total_tokens?: number;
};

export type ProbeResult = {
  status?: string;
  statusCode?: string;
  used?: string;
  reset?: string;
};

const ProbeResultKeySchema = z.enum(["status", "statusCode", "used", "reset"]);

const ResponseCompletedSchema = z.object({
  type: z.literal("response.completed"),
  response: z
    .object({
      usage: z
        .object({
          total_tokens: z
            .number()
            .optional()
            .refine((value) => value === undefined || Number.isFinite(value)),
        })
        .optional(),
    })
    .optional(),
});

export const val = (headers: Headers, key: string, fallback = "-"): string => {
  const value = headers.get(key) ?? "";
  return value !== "" ? value : fallback;
};

export const durationText = (secondsRaw: string): string => {
  const totalParsed = Number.parseInt(secondsRaw, 10);
  if (!Number.isFinite(totalParsed)) return "-";

  const total = Math.max(totalParsed, 0);
  const days = Math.floor(total / 86400);
  const remAfterDays = total % 86400;
  const hours = Math.floor(remAfterDays / 3600);
  const remAfterHours = remAfterDays % 3600;
  const minutes = Math.floor(remAfterHours / 60);

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
};

export const healthLabel = (primaryRaw: string, secondaryRaw: string): string => {
  const primary = Number.parseInt(primaryRaw, 10);
  const secondary = Number.parseInt(secondaryRaw, 10);

  if (!Number.isFinite(primary) || !Number.isFinite(secondary)) return "unknown";

  const peak = Math.max(primary, secondary);
  if (peak >= 90) return "critical";
  if (peak >= 75) return "warn";
  return "ok";
};

export const extractCompletedUsageFromSse = (text: string): ProbeUsage | null => {
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (!payload || payload === "[DONE]") continue;

    try {
      const event: unknown = JSON.parse(payload);
      const completed = ResponseCompletedSchema.safeParse(event);
      if (!completed.success) continue;
      return completed.data.response?.usage ?? null;
    } catch {
      continue;
    }
  }

  return null;
};

export const parseProbeLine = (line: string): ProbeResult => {
  const result: ProbeResult = {};
  const normalizedLine = line.trim();
  if (normalizedLine === "") return result;

  const tokens = normalizedLine.split(/\s+/);
  for (const token of tokens) {
    const idx = token.indexOf("=");
    if (idx <= 0) continue;
    const key = token.slice(0, idx);
    const value = token.slice(idx + 1);
    const parsedKey = ProbeResultKeySchema.safeParse(key);
    if (!parsedKey.success) continue;
    result[parsedKey.data] = value;
  }
  return result;
};

export const statusState = (raw: string | undefined): string => {
  const value = raw ?? "";
  const match = value.match(/^([A-Za-z]+)/);
  return match ? match[1].toLowerCase() : "unknown";
};
