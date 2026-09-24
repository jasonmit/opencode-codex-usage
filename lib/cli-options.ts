export type CliOptions = {
  help: boolean;
  noNotify: boolean;
  pretty: boolean;
  printJson: boolean;
  retryCount?: number;
  install: boolean;
  uninstall: boolean;
  configPath?: string;
  opencodeVersion: 1 | 2;
};

export const helpText = () => {
  return [
    "Usage: opencode-codex-usage [options]",
    "",
    "Options:",
    "  -h, --help        Show this help message",
    "  --json            Print JSON on success",
    "  --verbose         Alias for --json",
    "  --pretty          Show human-friendly quota output",
    "  --no-notify       Skip writing trigger signal file",
    "  --retry <count>   Retry transient probe failures (0-2)",
    "  --install         Add plugin path to OpenCode config",
    "  --uninstall       Remove plugin path from OpenCode config",
    "  --config <path>   Config file path to use with --install/--uninstall",
    "  --opencode <1|2>  OpenCode version for setup and queries (default: 2)",
    "",
    "Examples:",
    "  opencode-codex-usage",
    "  opencode-codex-usage --json",
    "  opencode-codex-usage --install",
    "  opencode-codex-usage --uninstall",
  ].join("\n");
};

export const wantsPrettyOutput = (argv: string[]): boolean => {
  return argv.some((arg) => arg === "--pretty");
};

export const wantsJsonOutput = (argv: string[]): boolean => {
  return argv.some((arg) => arg === "--json" || arg === "--verbose");
};

const parseRetryCount = (raw: string): number => {
  const normalized = raw.trim();

  if (!/^\d+$/.test(normalized)) {
    throw new Error("--retry requires an integer between 0 and 2");
  }

  const parsed = Number.parseInt(normalized, 10);

  if (parsed < 0 || parsed > 2) {
    throw new Error("--retry requires a value between 0 and 2");
  }

  return parsed;
};

const parseOpenCodeVersion = (raw: string): 1 | 2 => {
  if (raw === "1") return 1;

  if (raw === "2") return 2;
  throw new Error("--opencode must be 1 or 2");
};

export const parseCliOptions = (argv: string[]): CliOptions => {
  let help = false;
  let noNotify = false;
  let pretty = false;
  let printJson = false;
  let retryCount: number | undefined;
  let install = false;
  let uninstall = false;
  let configPath: string | undefined;
  let opencodeVersion: 1 | 2 = 2;

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx] ?? "";

    if (arg === "--no-notify") {
      noNotify = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--json" || arg === "--verbose") {
      printJson = true;
      continue;
    }

    if (arg === "--pretty") {
      pretty = true;
      printJson = true;
      continue;
    }

    if (arg === "--install" || arg === "--setup") {
      install = true;
      continue;
    }

    if (arg === "--uninstall") {
      uninstall = true;
      continue;
    }

    if (arg === "--retry") {
      const rawValue = argv[idx + 1];

      if (!rawValue || rawValue.startsWith("--")) {
        throw new Error("--retry requires a value");
      }

      retryCount = parseRetryCount(rawValue);
      idx += 1;
      continue;
    }

    if (arg.startsWith("--retry=")) {
      retryCount = parseRetryCount(arg.slice("--retry=".length));
      continue;
    }

    if (arg === "--config") {
      const rawValue = argv[idx + 1];

      if (!rawValue || rawValue.startsWith("--")) {
        throw new Error("--config requires a value");
      }

      configPath = rawValue;
      idx += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }

    if (arg === "--opencode") {
      const rawValue = argv[idx + 1];

      if (!rawValue || rawValue.startsWith("--")) {
        throw new Error("--opencode requires a value");
      }

      opencodeVersion = parseOpenCodeVersion(rawValue);
      idx += 1;
      continue;
    }

    if (arg.startsWith("--opencode=")) {
      opencodeVersion = parseOpenCodeVersion(arg.slice("--opencode=".length));
      continue;
    }
  }

  if (install && uninstall) {
    throw new Error("--install and --uninstall cannot be combined");
  }

  return {
    help,
    noNotify,
    pretty,
    printJson,
    retryCount,
    install,
    uninstall,
    configPath,
    opencodeVersion,
  };
};
