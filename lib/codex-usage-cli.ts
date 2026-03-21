import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatProbeOutput, probeQuota } from "./codex-usage-probe.js";
import { statusState } from "./quota-format.js";
import { resolveSignalPath } from "./codex-usage-signal.js";

export type CliOptions = {
  help: boolean;
  noNotify: boolean;
  pretty: boolean;
  printJson: boolean;
  setup: boolean;
  setupConfigPath?: string;
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
    "  --setup           Add plugin path to OpenCode config",
    "  --config <path>   Config file path to use with --setup",
    "",
    "Examples:",
    "  opencode-codex-usage",
    "  opencode-codex-usage --json",
    "  opencode-codex-usage --setup --config ~/.config/opencode/opencode.jsonc",
  ].join("\n");
};

const findMatchingBracket = (text: string, openIndex: number): number => {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
};

const addToPluginArray = (content: string, pluginPathLiteral: string): string | null => {
  const pluginMatch = /"plugin"\s*:\s*\[/m.exec(content);
  if (!pluginMatch || pluginMatch.index === undefined) return null;

  const openIndex = content.indexOf("[", pluginMatch.index);
  if (openIndex < 0) return null;

  const closeIndex = findMatchingBracket(content, openIndex);
  if (closeIndex < 0) return null;

  const lineStart = content.lastIndexOf("\n", pluginMatch.index) + 1;
  const baseIndent = content.slice(lineStart, pluginMatch.index).match(/^\s*/)?.[0] ?? "";
  const itemIndent = `${baseIndent}  `;

  let prefix = content.slice(0, closeIndex).trimEnd();
  const suffix = content.slice(closeIndex);

  if (prefix.endsWith("[")) {
    prefix += `\n${itemIndent}${pluginPathLiteral}\n${baseIndent}`;
  } else {
    if (!prefix.endsWith(",")) {
      prefix += ",";
    }
    prefix += `\n${itemIndent}${pluginPathLiteral}\n${baseIndent}`;
  }

  return `${prefix}${suffix}`;
};

const addPluginProperty = (content: string, pluginPathLiteral: string): string | null => {
  const firstBrace = content.indexOf("{");
  if (firstBrace < 0) return null;

  const insertion = `\n  "plugin": [\n    ${pluginPathLiteral}\n  ],`;
  return `${content.slice(0, firstBrace + 1)}${insertion}${content.slice(firstBrace + 1)}`;
};

const pluginPathFromModule = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "..", "index.js");
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

const runSetup = async (configPath: string): Promise<void> => {
  const pluginPath = pluginPathFromModule();
  const pluginStat = await lstatIfExists(pluginPath);

  if (!pluginStat) {
    throw new Error(
      `built plugin not found at ${pluginPath}; run \"npm run build\" first, then rerun opencode-codex-usage --setup`,
    );
  }

  const pluginPathLiteral = JSON.stringify(pluginPath);
  await mkdir(path.dirname(configPath), { recursive: true });

  const configStat = await lstatIfExists(configPath);

  if (!configStat) {
    const freshConfig = `{
  "plugin": [
    ${pluginPathLiteral}
  ]
}\n`;
    await writeFile(configPath, freshConfig, "utf8");
    process.stdout.write(`Created ${configPath} with plugin path.\n`);
    return;
  }

  const content = await readFile(configPath, "utf8");
  let nextContent = content;
  let updated = false;

  if (!nextContent.includes(pluginPathLiteral)) {
    const withPlugin =
      addToPluginArray(nextContent, pluginPathLiteral) ??
      addPluginProperty(nextContent, pluginPathLiteral);

    if (withPlugin === null) {
      throw new Error(
        `could not safely update ${configPath}; add this path manually to your plugin array:\n${pluginPath}`,
      );
    }

    nextContent = withPlugin;
    updated = true;
  }

  if (!updated) {
    process.stdout.write(`No changes needed. Plugin path is already configured.\n`);
    return;
  }

  await writeFile(configPath, nextContent, "utf8");
  process.stdout.write(`Updated ${configPath} with plugin path.\n`);
};

const wantsPrettyOutput = (argv: string[]): boolean => {
  return argv.some((arg) => arg === "--pretty");
};

const wantsJsonOutput = (argv: string[]): boolean => {
  return argv.some((arg) => arg === "--json" || arg === "--verbose");
};

export const parseCliOptions = (argv: string[]): CliOptions => {
  let help = false;
  let noNotify = false;
  let pretty = false;
  let printJson = false;
  let setup = false;
  let setupConfigPath: string | undefined;

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

    if (arg === "--setup") {
      setup = true;
      continue;
    }

    if (arg === "--config") {
      const rawValue = argv[idx + 1];
      if (!rawValue || rawValue.startsWith("--")) {
        throw new Error("--config requires a value");
      }
      setupConfigPath = rawValue;
      idx += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      setupConfigPath = arg.slice("--config=".length);
      continue;
    }
  }

  return { help, noNotify, pretty, printJson, setup, setupConfigPath };
};

export const runCli = async (argv: string[] = process.argv.slice(2)): Promise<void> => {
  const options = parseCliOptions(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  if (options.setup) {
    const defaultConfigPath = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc");
    const configPath = options.setupConfigPath
      ? path.resolve(options.setupConfigPath)
      : defaultConfigPath;
    await runSetup(configPath);
    return;
  }

  const snapshot = await probeQuota();
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
