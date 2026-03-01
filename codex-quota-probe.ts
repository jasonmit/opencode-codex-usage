import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveAuthPath } from "./lib/auth-path.js";
import {
  durationText,
  extractCompletedUsageFromSse,
  healthLabel,
  val,
} from "./lib/quota-format.js";

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
  used?: WindowPair<number | null> | string;
  reset?: WindowPair<string | null> | string;
  windowMinutes?: WindowPair<number | null> | string;
  plan?: string;
  profile?: string;
  probeTokens?: number;
  error?: string;
};

const toProbeError = (status: string, detail: string): ProbeSnapshot => {
  return {
    status,
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

export const formatProbeOutput = (snapshot: ProbeSnapshot): string => {
  return JSON.stringify(snapshot);
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
      return toProbeError("ERROR(auth)", "missing access token");
    }
  } catch (error) {
    const detail = errorMessage(error);
    return toProbeError("ERROR(auth)", detail.slice(0, 120));
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
      return toProbeError("ERROR(timeout)", `request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }

    const detail = errorMessage(error);
    return toProbeError("ERROR(network)", detail.slice(0, 120));
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = responseText.slice(0, 120).replace(/\n/g, " ").trim();
    return toProbeError(`ERROR(${response.status})`, detail);
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
    status: `${state}(${response.status})`,
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

const runCli = async (): Promise<void> => {
  const line = await probeQuotaLine();
  console.log(line);
};

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);

if (executedPath !== "" && modulePath === executedPath) {
  void runCli();
}
