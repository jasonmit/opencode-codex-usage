import { readFile } from "node:fs/promises";
import { z } from "zod";
import { resolveAuthPath } from "./auth-path.js";
import {
  durationText,
  extractCompletedUsageFromSse,
  healthLabel,
  statusState,
  val,
} from "./quota-format.js";

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
const RETRY_COUNT_ENV = "OPENCODE_CODEX_QUOTA_RETRY_COUNT";
const MODEL_ENV = "OPENCODE_CODEX_QUOTA_MODEL";
const MAX_RETRY_COUNT = 2;
const DEFAULT_PROBE_MODEL = "gpt-5.3-codex";

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

export type ProbeQuotaOptions = {
  retryCount?: number;
  timeoutMs?: number;
  model?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  credentials?: {
    accessToken: string;
    accountId?: string;
  };
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

export const normalizeUsagePercent = (raw: string): number | null => {
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed)) return null;

  const normalized = parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed;
  const bounded = Math.max(0, Math.min(100, normalized));
  return Math.round(bounded);
};

export const normalizeResetValue = (raw: string, nowMs = Date.now()): string | null => {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) {
    const fallback = durationText(trimmed);
    return fallback === "-" ? null : fallback;
  }

  let secondsRemaining = parsed;
  if (parsed > 1_000_000_000_000) {
    secondsRemaining = (parsed - nowMs) / 1000;
  } else if (parsed > 1_000_000_000) {
    secondsRemaining = parsed - nowMs / 1000;
  }

  const value = durationText(String(Math.max(0, Math.floor(secondsRemaining))));
  return value === "-" ? null : value;
};

const parseOptionalDuration = (secondsRaw: string, nowMs: number): string | null => {
  return normalizeResetValue(secondsRaw, nowMs);
};

const parseRetryCount = (raw: string | undefined, fallback = 1): number => {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, MAX_RETRY_COUNT);
};

export const resolveProbeRetryCount = (
  env: NodeJS.ProcessEnv = process.env,
  fallback = 1,
): number => {
  return parseRetryCount(env[RETRY_COUNT_ENV], fallback);
};

export const resolveProbeModel = (
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_PROBE_MODEL,
): string => {
  const configured = env[MODEL_ENV]?.trim();
  return configured && configured !== "" ? configured : fallback;
};

const parseProbeErrorDetail = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed === "") return "empty error response";

  try {
    const parsed = JSON.parse(trimmed) as {
      detail?: unknown;
      error?: { message?: unknown };
      message?: unknown;
    };
    if (typeof parsed.detail === "string" && parsed.detail.trim() !== "") {
      return parsed.detail.trim();
    }
    if (typeof parsed.error?.message === "string" && parsed.error.message.trim() !== "") {
      return parsed.error.message.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim() !== "") {
      return parsed.message.trim();
    }
  } catch {
    // Not JSON. Fall back to compact text.
  }

  return trimmed.replace(/\s+/g, " ");
};

const shouldRetryStatusCode = (statusCode: number | string | undefined): boolean => {
  if (statusCode === "network" || statusCode === "timeout") return true;
  if (typeof statusCode === "number") {
    if (statusCode >= 500) return true;
    if (statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429) {
      return true;
    }
  }
  return false;
};

export const isRetryableProbeFailure = (snapshot: ProbeSnapshot): boolean => {
  if (statusState(snapshot.status) !== "error") return false;
  return shouldRetryStatusCode(snapshot.statusCode);
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

const loadCredentials = async (
  options: ProbeQuotaOptions,
): Promise<{ access: string; accountId: string } | ProbeSnapshot> => {
  if (options.credentials) {
    const access = options.credentials.accessToken.trim();
    if (access === "") {
      return toProbeError("error", "missing access token", "auth");
    }
    return { access, accountId: options.credentials.accountId ?? "" };
  }

  let access = "";
  let accountId = "";

  try {
    const authPath = resolveAuthPath();
    const authRaw = await readFile(authPath, "utf8");
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

  return { access, accountId };
};

const runProbeAttempt = async (
  access: string,
  accountId: string,
  options: {
    model: string;
    timeoutMs: number;
    fetchImpl: typeof fetch;
    nowMs: number;
  },
): Promise<ProbeSnapshot> => {
  const body = {
    model: options.model,
    instructions: "You are a coding assistant.",
    input: [{ role: "user", content: [{ type: "input_text", text: "reply ok" }] }],
    store: false,
    stream: true,
  };

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);

  let response: Response;
  let responseText = "";

  try {
    response = await options.fetchImpl(CODEX_URL, {
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
      signal: timeoutSignal,
    });

    responseText = await response.text();
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return toProbeError("error", `request timed out after ${options.timeoutMs}ms`, "timeout");
    }

    const detail = errorMessage(error);
    return toProbeError("error", detail.slice(0, 120), "network");
  }

  if (!response.ok) {
    const detail = parseProbeErrorDetail(responseText).slice(0, 240);
    return toProbeError("error", detail, response.status);
  }

  const usage = extractCompletedUsageFromSse(responseText);
  const primaryUsedRaw = val(response.headers, "x-codex-primary-used-percent", "");
  const secondaryUsedRaw = val(response.headers, "x-codex-secondary-used-percent", "");
  const primaryResetSeconds = val(response.headers, "x-codex-primary-reset-after-seconds", "");
  const secondaryResetSeconds = val(response.headers, "x-codex-secondary-reset-after-seconds", "");
  const primaryWindowMinutesRaw = val(response.headers, "x-codex-primary-window-minutes", "");
  const secondaryWindowMinutesRaw = val(response.headers, "x-codex-secondary-window-minutes", "");
  const plan = val(response.headers, "x-codex-plan-type");
  const profile = val(response.headers, "x-codex-bengalfox-limit-name");
  const probeTokens = usage?.total_tokens ?? 0;
  const primaryUsed = normalizeUsagePercent(primaryUsedRaw) ?? parseOptionalInt(primaryUsedRaw);
  const secondaryUsed =
    normalizeUsagePercent(secondaryUsedRaw) ?? parseOptionalInt(secondaryUsedRaw);
  const primaryReset = parseOptionalDuration(primaryResetSeconds, options.nowMs);
  const secondaryReset = parseOptionalDuration(secondaryResetSeconds, options.nowMs);
  const primaryWindowMinutes = parseOptionalInt(primaryWindowMinutesRaw);
  const secondaryWindowMinutes = parseOptionalInt(secondaryWindowMinutesRaw);
  const hasWindowMinutes = primaryWindowMinutes !== null || secondaryWindowMinutes !== null;
  const state =
    primaryUsed !== null && secondaryUsed !== null
      ? healthLabel(String(primaryUsed), String(secondaryUsed))
      : healthLabel(primaryUsedRaw, secondaryUsedRaw);

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

export const probeQuota = async (options: ProbeQuotaOptions = {}): Promise<ProbeSnapshot> => {
  const model = options.model?.trim() || resolveProbeModel(options.env);
  const retryCount = Math.min(
    options.retryCount ?? resolveProbeRetryCount(options.env),
    MAX_RETRY_COUNT,
  );
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = Date.now();

  const credentials = await loadCredentials(options);
  if ("status" in credentials) {
    return credentials;
  }

  let snapshot = await runProbeAttempt(credentials.access, credentials.accountId, {
    model,
    timeoutMs,
    fetchImpl,
    nowMs,
  });

  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    if (!isRetryableProbeFailure(snapshot)) break;
    snapshot = await runProbeAttempt(credentials.access, credentials.accountId, {
      model,
      timeoutMs,
      fetchImpl,
      nowMs,
    });
  }

  return snapshot;
};

export const probeQuotaLine = async (): Promise<string> => {
  const snapshot = await probeQuota();
  return formatProbeOutput(snapshot);
};
