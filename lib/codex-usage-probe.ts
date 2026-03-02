import { readFileSync } from "node:fs";
import { z } from "zod";
import { resolveAuthPath } from "./auth-path.js";
import { durationText, extractCompletedUsageFromSse, healthLabel, val } from "./quota-format.js";

type AuthFile = {
  openai?: {
    access?: string;
    accountId?: string;
  };
};

const AuthSchema = z.object({
  openai: z
    .object({
      access: z.string().optional(),
      accountId: z.string().optional(),
    })
    .optional(),
});

const parseAuthFile = (raw: string): AuthFile => {
  const parsed: unknown = JSON.parse(raw);
  const validated = AuthSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error("invalid auth file shape");
  }

  return validated.data;
};

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const REQUEST_TIMEOUT_MS = 15_000;

type WindowPair<T> = {
  primary: T;
  secondary: T;
};

export type ProbeSnapshot = {
  status: string;
  statusCode?: number | string;
  used?: WindowPair<number | null> | string;
  reset?: WindowPair<string | null> | string;
  windowMinutes?: WindowPair<number | null> | string;
  plan?: string;
  profile?: string;
  probeTokens?: number;
  error?: string;
};

const toProbeError = (
  status: string,
  detail: string,
  statusCode?: number | string,
): ProbeSnapshot => {
  return {
    status,
    ...(statusCode !== undefined ? { statusCode } : {}),
    error: detail,
  };
};

const parseOptionalInt = (raw: string): number | null => {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseOptionalDuration = (secondsRaw: string): string | null => {
  const value = durationText(secondsRaw);
  return value === "-" ? null : value;
};

const percentText = (value: number | null | undefined): string => {
  if (!Number.isFinite(value ?? Number.NaN)) return "-";
  const bounded = Math.max(0, Math.min(100, Number(value)));
  return `${Math.round(bounded)}%`;
};

const windowLabel = (minutes: number | null | undefined, fallback: string): string => {
  if (!Number.isFinite(minutes ?? Number.NaN)) return fallback;
  const value = Number(minutes);
  if (value <= 0) return fallback;
  if (value % (24 * 60) === 0) return `${value / (24 * 60)}d window`;
  if (value % 60 === 0) return `${value / 60}h window`;
  return `${value}m window`;
};

const usageBar = (value: number | null | undefined, width = 20): string => {
  if (!Number.isFinite(value ?? Number.NaN)) return `[${"-".repeat(width)}]`;
  const bounded = Math.max(0, Math.min(100, Number(value)));
  const filled = Math.round((bounded / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
};

const prettyLine = (
  label: string,
  labelWidth: number,
  used: number | null | undefined,
  reset: string | null | undefined,
): string => {
  const usage = percentText(used);
  const resetText = reset && reset.trim() !== "" ? reset : "-";
  const title = `${label}:`.padEnd(labelWidth + 2);
  return `${title}${usageBar(used)} ${usage.padStart(4)}  ⏳ ${resetText}`;
};

const prettyMetaLine = (label: string, labelWidth: number, value: string): string => {
  const title = `${label}:`.padEnd(labelWidth + 2);
  return `${title}${value}`;
};

const prettyState = (status: string): string => {
  const upper = status.toUpperCase();
  if (upper === "OK") return upper;
  if (upper === "WARN") return upper;
  if (upper === "CRITICAL") return upper;
  if (upper === "ERROR") return upper;
  return "UNKNOWN";
};

const statusEmoji = (state: string): string => {
  if (state === "OK") return "✅";
  if (state === "WARN") return "⚠️";
  if (state === "CRITICAL") return "🚨";
  if (state === "ERROR") return "🚨";
  return "❓";
};

const pairOrNull = <T>(value: WindowPair<T | null> | string | undefined): WindowPair<T | null> => {
  if (typeof value !== "object" || value === null) {
    return { primary: null, secondary: null };
  }

  return {
    primary: value.primary ?? null,
    secondary: value.secondary ?? null,
  };
};

const formatPrettyProbeOutput = (snapshot: ProbeSnapshot): string => {
  const state = prettyState(snapshot.status);
  const stateWithEmoji = `${state} ${statusEmoji(state)}`;

  if (snapshot.error) {
    return [
      prettyMetaLine("codex quota probe", "codex quota probe".length, stateWithEmoji),
      prettyMetaLine("status code", "codex quota probe".length, String(snapshot.statusCode ?? "-")),
      prettyMetaLine("error", "codex quota probe".length, snapshot.error),
    ].join("\n");
  }

  const used = pairOrNull<number>(snapshot.used);
  const reset = pairOrNull<string>(snapshot.reset);
  const windowMinutes = pairOrNull<number>(snapshot.windowMinutes);

  const primaryLabel = windowLabel(windowMinutes.primary, "window A");
  const secondaryLabel = windowLabel(windowMinutes.secondary, "window B");
  const labelWidth = Math.max(
    "codex quota".length,
    "status code".length,
    "plan / profile".length,
    primaryLabel.length,
    secondaryLabel.length,
  );

  const lines = [
    prettyMetaLine("codex quota", labelWidth, stateWithEmoji),
    prettyMetaLine("status code", labelWidth, String(snapshot.statusCode ?? "-")),
    prettyMetaLine(
      "plan / profile",
      labelWidth,
      `${snapshot.plan ?? "-"} / ${snapshot.profile ?? "-"}`,
    ),
    prettyLine(primaryLabel, labelWidth, used.primary, reset.primary),
    prettyLine(secondaryLabel, labelWidth, used.secondary, reset.secondary),
  ];

  return lines.join("\n");
};

export const formatProbeOutput = (
  snapshot: ProbeSnapshot,
  options: { pretty?: boolean; printJson?: boolean } = {},
): string => {
  if (options.pretty) return formatPrettyProbeOutput(snapshot);
  return JSON.stringify(snapshot, null, options.printJson ? 2 : 0);
};

export const probeQuota = async (): Promise<ProbeSnapshot> => {
  let access = "";
  let accountId = "";

  try {
    const authPath = resolveAuthPath();
    const authRaw = readFileSync(authPath, "utf8");
    const auth = parseAuthFile(authRaw);
    access = auth.openai?.access ?? "";
    accountId = auth.openai?.accountId ?? "";

    if (access.trim() === "") {
      return toProbeError("error", "missing access token", "auth");
    }
  } catch (error) {
    const detail = errorMessage(error);
    return toProbeError("error", detail.slice(0, 120), "auth");
  }

  const body = {
    model: "gpt-5.1-codex",
    instructions: "You are a coding assistant.",
    input: [{ role: "user", content: [{ type: "input_text", text: "reply ok" }] }],
    store: false,
    stream: true,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  let response: Response;
  let responseText = "";

  try {
    response = await fetch(CODEX_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "openai-beta": "responses=experimental",
        originator: "codex_cli_rs",
        "chatgpt-account-id": accountId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    responseText = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return toProbeError("error", `request timed out after ${REQUEST_TIMEOUT_MS}ms`, "timeout");
    }

    const detail = errorMessage(error);
    return toProbeError("error", detail.slice(0, 120), "network");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = responseText.slice(0, 120).replace(/\n/g, " ").trim();
    return toProbeError("error", detail, response.status);
  }

  const usage = extractCompletedUsageFromSse(responseText);
  const primaryUsedRaw = val(response.headers, "x-codex-primary-used-percent", "");
  const secondaryUsedRaw = val(response.headers, "x-codex-secondary-used-percent", "");
  const state = healthLabel(primaryUsedRaw, secondaryUsedRaw);
  const primaryResetSeconds = val(response.headers, "x-codex-primary-reset-after-seconds", "");
  const secondaryResetSeconds = val(response.headers, "x-codex-secondary-reset-after-seconds", "");
  const primaryWindowMinutesRaw = val(response.headers, "x-codex-primary-window-minutes", "");
  const secondaryWindowMinutesRaw = val(response.headers, "x-codex-secondary-window-minutes", "");
  const plan = val(response.headers, "x-codex-plan-type");
  const profile = val(response.headers, "x-codex-bengalfox-limit-name");
  const probeTokens = usage?.total_tokens ?? 0;
  const primaryUsed = parseOptionalInt(primaryUsedRaw);
  const secondaryUsed = parseOptionalInt(secondaryUsedRaw);
  const primaryReset = parseOptionalDuration(primaryResetSeconds);
  const secondaryReset = parseOptionalDuration(secondaryResetSeconds);
  const primaryWindowMinutes = parseOptionalInt(primaryWindowMinutesRaw);
  const secondaryWindowMinutes = parseOptionalInt(secondaryWindowMinutesRaw);
  const hasWindowMinutes = primaryWindowMinutes !== null || secondaryWindowMinutes !== null;

  return {
    status: state,
    statusCode: response.status,
    plan,
    profile,
    used: { primary: primaryUsed, secondary: secondaryUsed },
    reset: { primary: primaryReset, secondary: secondaryReset },
    ...(hasWindowMinutes
      ? { windowMinutes: { primary: primaryWindowMinutes, secondary: secondaryWindowMinutes } }
      : {}),
    probeTokens,
  };
};

export const probeQuotaLine = async (): Promise<string> => {
  const snapshot = await probeQuota();
  return formatProbeOutput(snapshot);
};
