import os from "node:os";
import path from "node:path";

type AuthPathOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export const resolveAuthPath = ({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
}: AuthPathOptions = {}): string => {
  if (env.OPENCODE_AUTH_PATH) {
    return env.OPENCODE_AUTH_PATH;
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    return path.join(localAppData, "opencode", "auth.json");
  }

  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "opencode", "auth.json");
  }

  const xdgDataHome = env.XDG_DATA_HOME || path.join(homeDir, ".local", "share");
  return path.join(xdgDataHome, "opencode", "auth.json");
};
