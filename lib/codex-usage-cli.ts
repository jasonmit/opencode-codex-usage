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
  retryCount?: number;
  install: boolean;
  uninstall: boolean;
  configPath?: string;
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
    "",
    "Examples:",
    "  opencode-codex-usage",
    "  opencode-codex-usage --json",
    "  opencode-codex-usage --install --config ~/.config/opencode/opencode.jsonc",
    "  opencode-codex-usage --uninstall",
  ].join("\n");
};

const escapeForRegExp = (text: string): string => {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

const splitTopLevelArrayItems = (content: string): string[] => {
  const items: string[] = [];
  let depthSquare = 0;
  let depthCurly = 0;
  let depthParen = 0;
  let inString = false;
  let escaped = false;
  let segmentStart = 0;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

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
      depthSquare += 1;
      continue;
    }
    if (char === "]") {
      depthSquare = Math.max(0, depthSquare - 1);
      continue;
    }
    if (char === "{") {
      depthCurly += 1;
      continue;
    }
    if (char === "}") {
      depthCurly = Math.max(0, depthCurly - 1);
      continue;
    }
    if (char === "(") {
      depthParen += 1;
      continue;
    }
    if (char === ")") {
      depthParen = Math.max(0, depthParen - 1);
      continue;
    }

    if (char === "," && depthSquare === 0 && depthCurly === 0 && depthParen === 0) {
      const entry = content.slice(segmentStart, index).trim();
      if (entry !== "") items.push(entry);
      segmentStart = index + 1;
    }
  }

  const tail = content.slice(segmentStart).trim();
  if (tail !== "") items.push(tail);

  return items;
};

const isPluginEntryMatch = (item: string, pluginPathLiteral: string): boolean => {
  if (item === pluginPathLiteral) return true;
  const escapedLiteral = escapeForRegExp(pluginPathLiteral);
  const tuplePattern = new RegExp(`^\\[\\s*${escapedLiteral}(?:\\s*,|\\s*\\])`);
  return tuplePattern.test(item);
};

const removeFromPluginArray = (content: string, pluginPathLiteral: string): string | null => {
  const pluginMatch = /"plugin"\s*:\s*\[/m.exec(content);
  if (!pluginMatch || pluginMatch.index === undefined) return null;

  const openIndex = content.indexOf("[", pluginMatch.index);
  if (openIndex < 0) return null;

  const closeIndex = findMatchingBracket(content, openIndex);
  if (closeIndex < 0) return null;

  const lineStart = content.lastIndexOf("\n", pluginMatch.index) + 1;
  const baseIndent = content.slice(lineStart, pluginMatch.index).match(/^\s*/)?.[0] ?? "";
  const itemIndent = `${baseIndent}  `;

  const inside = content.slice(openIndex + 1, closeIndex);
  const items = splitTopLevelArrayItems(inside);
  const nextItems = items.filter((item) => !isPluginEntryMatch(item, pluginPathLiteral));

  if (nextItems.length === items.length) return content;

  const rebuiltInside =
    nextItems.length === 0
      ? `\n${baseIndent}`
      : `\n${nextItems.map((item) => `${itemIndent}${item}`).join(",\n")}\n${baseIndent}`;

  return `${content.slice(0, openIndex + 1)}${rebuiltInside}${content.slice(closeIndex)}`;
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

const runInstall = async (configPath: string): Promise<void> => {
  const pluginPath = pluginPathFromModule();
  const pluginStat = await lstatIfExists(pluginPath);

  if (!pluginStat) {
    throw new Error(
      `built plugin not found at ${pluginPath}; run \"npm run build\" first, then rerun opencode-codex-usage --install`,
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

const runUninstall = async (configPath: string): Promise<void> => {
  const pluginPath = pluginPathFromModule();
  const pluginPathLiteral = JSON.stringify(pluginPath);
  const configStat = await lstatIfExists(configPath);

  if (!configStat) {
    process.stdout.write(`No changes needed. ${configPath} does not exist.\n`);
    return;
  }

  const content = await readFile(configPath, "utf8");
  const nextContent = removeFromPluginArray(content, pluginPathLiteral);

  if (nextContent === null) {
    throw new Error(
      `could not safely update ${configPath}; remove this path manually from your plugin array:\n${pluginPath}`,
    );
  }

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

export const parseCliOptions = (argv: string[]): CliOptions => {
  let help = false;
  let noNotify = false;
  let pretty = false;
  let printJson = false;
  let retryCount: number | undefined;
  let install = false;
  let uninstall = false;
  let configPath: string | undefined;

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
  }

  if (install && uninstall) {
    throw new Error("--install and --uninstall cannot be combined");
  }

  return { help, noNotify, pretty, printJson, retryCount, install, uninstall, configPath };
};

export const runCli = async (argv: string[] = process.argv.slice(2)): Promise<void> => {
  const options = parseCliOptions(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  if (options.install || options.uninstall) {
    const defaultConfigPath = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc");
    const configPath = options.configPath ? path.resolve(options.configPath) : defaultConfigPath;
    if (options.install) {
      await runInstall(configPath);
    } else {
      await runUninstall(configPath);
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
