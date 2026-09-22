import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse, type ModificationOptions, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { formatProbeOutput, probeQuota } from "./codex-usage-probe.js";
import { statusState } from "./quota-format.js";
import { resolveSignalPath } from "./codex-usage-signal.js";

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

const helpText = () => {
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
    "  --opencode <1|2>  OpenCode config version (default: 2)",
    "",
    "Examples:",
    "  opencode-codex-usage",
    "  opencode-codex-usage --json",
    "  opencode-codex-usage --install",
    "  opencode-codex-usage --uninstall",
  ].join("\n");
};

const configSchema = z.record(z.string(), z.unknown());

const modificationOptions = {
  formattingOptions: {
    insertSpaces: true,
    tabSize: 2,
    eol: "\n",
  },
} satisfies ModificationOptions;

const parseConfig = (content: string, configPath: string): Record<string, unknown> => {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`could not safely update ${configPath}; configuration contains invalid JSONC`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`could not safely update ${configPath}; configuration root must be an object`);
  }
  return result.data;
};

const pluginEntryMatches = (entry: unknown, pluginPath: string): boolean => {
  return entry === pluginPath || (Array.isArray(entry) && entry[0] === pluginPath);
};

const pluginEntries = (
  content: string,
  configPath: string,
  property: "plugin" | "plugins",
): unknown[] | undefined => {
  const config = parseConfig(content, configPath);
  if (!Object.hasOwn(config, property)) return undefined;

  const entries = config[property];
  if (!Array.isArray(entries)) {
    throw new Error(
      `could not safely update ${configPath}; root ${property} property must be an array`,
    );
  }
  return entries;
};

const addPluginEntry = (
  content: string,
  configPath: string,
  pluginPath: string,
  property: "plugin" | "plugins",
): string => {
  const entries = pluginEntries(content, configPath, property);
  if (entries?.some((entry) => pluginEntryMatches(entry, pluginPath))) return content;

  const edits = entries
    ? modify(content, [property, -1], pluginPath, modificationOptions)
    : modify(content, [property], [pluginPath], modificationOptions);
  return applyEdits(content, edits);
};

const removePluginEntries = (
  content: string,
  configPath: string,
  pluginPath: string,
  property: "plugin" | "plugins",
): string => {
  const entries = pluginEntries(content, configPath, property);
  if (!entries) {
    throw new Error(
      `could not safely update ${configPath}; remove this path manually from your plugin array:\n${pluginPath}`,
    );
  }

  const matchingIndexes = entries
    .map((entry, index) => (pluginEntryMatches(entry, pluginPath) ? index : -1))
    .filter((index) => index >= 0)
    .reverse();

  return matchingIndexes.reduce(
    (nextContent, index) =>
      applyEdits(
        nextContent,
        modify(nextContent, [property, index], undefined, modificationOptions),
      ),
    content,
  );
};

export const resolvePluginInstallPath = (moduleDir: string): string => {
  return path.resolve(moduleDir, "..", "..");
};

export const resolveTuiConfigPath = (configPath: string, opencodeVersion: 1 | 2 = 1): string => {
  return path.join(path.dirname(configPath), opencodeVersion === 2 ? "cli.json" : "tui.json");
};

const pluginPathFromModule = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return resolvePluginInstallPath(moduleDir);
};

const isNotFoundError = (error: unknown): boolean => {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
};

const lstatIfExists = async (
  targetPath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> => {
  try {
    return await lstat(targetPath);
  } catch (error: unknown) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
};

const writeSignalFileSafely = async (signalPath: string, stamp: string): Promise<void> => {
  const signalStat = await lstatIfExists(signalPath);

  if (signalStat?.isSymbolicLink()) {
    throw new Error(`refusing to write trigger file through symlink: ${signalPath}`);
  }

  const tempPath = `${signalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, stamp, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, signalPath);
  } finally {
    await rm(tempPath, { force: true });
  }
};

const runInstall = async (
  configPath: string,
  pluginPath: string,
  property: "plugin" | "plugins",
  verifyPluginPath: boolean,
): Promise<boolean> => {
  const pluginStat = verifyPluginPath ? await lstatIfExists(pluginPath) : true;

  if (!pluginStat) {
    throw new Error(
      `built plugin not found at ${pluginPath}; run "npm run build" first, then rerun opencode-codex-usage --install`,
    );
  }

  const pluginPathLiteral = JSON.stringify(pluginPath);
  await mkdir(path.dirname(configPath), { recursive: true });

  const configStat = await lstatIfExists(configPath);

  if (!configStat) {
    const freshConfig = `{
  "${property}": [
    ${pluginPathLiteral}
  ]
}\n`;
    await writeFile(configPath, freshConfig, "utf8");
    process.stdout.write(`Created ${configPath} with plugin path.\n`);
    return true;
  }

  const content = await readFile(configPath, "utf8");
  const nextContent = addPluginEntry(content, configPath, pluginPath, property);
  if (nextContent === content) return false;

  await writeFile(configPath, nextContent, "utf8");
  process.stdout.write(`Updated ${configPath} with plugin path.\n`);
  return true;
};

const runUninstall = async (
  configPath: string,
  pluginPath: string,
  property: "plugin" | "plugins",
): Promise<void> => {
  const configStat = await lstatIfExists(configPath);

  if (!configStat) {
    process.stdout.write(`No changes needed. ${configPath} does not exist.\n`);
    return;
  }

  const content = await readFile(configPath, "utf8");
  const nextContent = removePluginEntries(content, configPath, pluginPath, property);

  if (nextContent === content) {
    process.stdout.write(`No changes needed. Plugin path is not configured.\n`);
    return;
  }

  await writeFile(configPath, nextContent, "utf8");
  process.stdout.write(`Updated ${configPath} by removing plugin path.\n`);
};

const wantsPrettyOutput = (argv: string[]): boolean => {
  return argv.some((arg) => arg === "--pretty");
};

const wantsJsonOutput = (argv: string[]): boolean => {
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

export const runCli = async (argv: string[] = process.argv.slice(2)): Promise<void> => {
  const options = parseCliOptions(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  if (options.install || options.uninstall) {
    const configDirectory = options.opencodeVersion === 2 ? "opencode2" : "opencode";
    const defaultConfigPath = path.join(os.homedir(), ".config", configDirectory, "opencode.jsonc");
    const configPath = options.configPath ? path.resolve(options.configPath) : defaultConfigPath;
    const tuiConfigPath = resolveTuiConfigPath(configPath, options.opencodeVersion);
    const isV2 = options.opencodeVersion === 2;
    const property = isV2 ? "plugins" : "plugin";
    const packageRoot = pluginPathFromModule();
    const serverPlugin = isV2 ? path.join(packageRoot, "opencode2-plugin") : packageRoot;
    const tuiPlugin = isV2 ? path.join(packageRoot, "opencode2-tui-plugin") : serverPlugin;
    if (options.install) {
      const serverChanged = await runInstall(configPath, serverPlugin, property, true);
      const tuiChanged = await runInstall(tuiConfigPath, tuiPlugin, property, true);
      if (!serverChanged && !tuiChanged) {
        process.stdout.write(`No changes needed. Server and TUI plugins are already configured.\n`);
      }
    } else {
      await runUninstall(configPath, serverPlugin, property);
      await runUninstall(tuiConfigPath, tuiPlugin, property);
    }
    return;
  }

  const snapshot = await probeQuota({ retryCount: options.retryCount });
  const state = statusState(snapshot.status);
  const hasError = state === "error";
  const line = formatProbeOutput(snapshot, {
    pretty: options.pretty,
    printJson: options.printJson,
  });

  if (hasError) {
    process.stderr.write(`${line}\n`);
    process.exitCode = 1;
  } else if (options.printJson) {
    process.stdout.write(`${line}\n`);
  }

  const shouldNotify = !options.noNotify;
  if (!shouldNotify) return;

  const signalPath = resolveSignalPath();
  const stamp = `${Date.now()}\n`;
  await writeSignalFileSafely(signalPath, stamp);
};

export const runCliSafely = async (argv: string[] = process.argv.slice(2)): Promise<void> => {
  try {
    await runCli(argv);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const line = formatProbeOutput(
      { status: "error", statusCode: "local", error: detail },
      { pretty: wantsPrettyOutput(argv), printJson: wantsJsonOutput(argv) },
    );
    process.stderr.write(`${line}\n`);
    process.exitCode = 1;
  }
};
