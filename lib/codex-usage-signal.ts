import os from "node:os";
import path from "node:path";

export const SIGNAL_FILENAME = ".opencode-codex-usage-trigger";
const SIGNAL_PATH_ENV = "OPENCODE_CODEX_USAGE_SIGNAL_PATH";

const signalOwnerTag = (env: NodeJS.ProcessEnv = process.env): string => {
  if (typeof process.getuid === "function") {
    return `uid-${process.getuid()}`;
  }

  const rawUser = env.USER ?? env.USERNAME ?? "unknown";
  const safeUser = rawUser.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `user-${safeUser}`;
};

export const resolveSignalPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const configured = env[SIGNAL_PATH_ENV]?.trim();
  if (configured) return path.resolve(configured);

  const filename = `${SIGNAL_FILENAME}-${signalOwnerTag(env)}`;
  return path.join(os.tmpdir(), filename);
};
