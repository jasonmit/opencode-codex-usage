import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
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
    "  --opencode <1|2>  OpenCode config version (default: 1)",
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

const maskJsoncComments = (text: string): string => {
  const chars = text.split("");
  let inString = false;
  let escaped = false;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < chars.length && chars[index] !== "\n") {
        chars[index] = " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 2;
      while (index < chars.length) {
        if (chars[index] === "*" && chars[index + 1] === "/") {
          chars[index] = " ";
          chars[index + 1] = " ";
          index += 1;
          break;
        }
        if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
        index += 1;
      }
    }
  }

  return chars.join("");
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

type PluginArrayLocation = {
  propertyIndex: number;
  openIndex: number;
  closeIndex: number;
};

const structuralDepthAt = (
  text: string,
  endIndex: number,
): { curly: number; square: number; inString: boolean } => {
  let curly = 0;
  let square = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < endIndex; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
  }
  return { curly, square, inString };
};

const findPluginArray = (
  content: string,
  property: "plugin" | "plugins",
): PluginArrayLocation | undefined => {
  const searchable = maskJsoncComments(content);
  const pattern = new RegExp(`"${property}"\\s*:\\s*\\[`, "gm");
  for (const match of searchable.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const depth = structuralDepthAt(searchable, match.index);
    if (depth.inString || depth.curly !== 1 || depth.square !== 0) continue;
    const openIndex = searchable.indexOf("[", match.index);
    const closeIndex = findMatchingBracket(searchable, openIndex);
    if (openIndex >= 0 && closeIndex >= 0) {
      return { propertyIndex: match.index, openIndex, closeIndex };
    }
  }
  return undefined;
};

const hasRootProperty = (content: string, property: "plugin" | "plugins"): boolean => {
  const searchable = maskJsoncComments(content);
  const pattern = new RegExp(`"${property}"\\s*:`, "gm");
  for (const match of searchable.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const depth = structuralDepthAt(searchable, match.index);
    if (!depth.inString && depth.curly === 1 && depth.square === 0) return true;
  }
  return false;
};

const rootObjectStart = (content: string): number => {
  const searchable = maskJsoncComments(content);
  const depth = structuralDepthAt(searchable, searchable.length);
  if (depth.curly < 0) return -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < searchable.length; index += 1) {
    const char = searchable[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") return index;
  }
  return -1;
};

const addToPluginArray = (
  content: string,
  pluginPathLiteral: string,
  property: "plugin" | "plugins",
): string | null => {
  const searchable = maskJsoncComments(content);
  const location = findPluginArray(content, property);
  if (!location) return null;
  const { propertyIndex, closeIndex } = location;

  const lineStart = content.lastIndexOf("\n", propertyIndex) + 1;
  const baseIndent = content.slice(lineStart, propertyIndex).match(/^\s*/)?.[0] ?? "";
  const itemIndent = `${baseIndent}  `;

  let structuralEnd = closeIndex - 1;
  while (/\s/.test(searchable[structuralEnd] ?? "")) structuralEnd -= 1;
  const lastStructuralChar = searchable[structuralEnd];
  let prefix = content.slice(0, structuralEnd + 1);
  if (lastStructuralChar !== "[" && lastStructuralChar !== ",") prefix += ",";
  prefix += content.slice(structuralEnd + 1, closeIndex).trimEnd();
  const suffix = content.slice(closeIndex);

  prefix += `\n${itemIndent}${pluginPathLiteral}\n${baseIndent}`;

  return `${prefix}${suffix}`;
};

const addPluginProperty = (
  content: string,
  pluginPathLiteral: string,
  property: "plugin" | "plugins",
): string | null => {
  const firstBrace = rootObjectStart(content);
  if (firstBrace < 0) return null;

  const insertion = `\n  "${property}": [\n    ${pluginPathLiteral}\n  ],`;
  return `${content.slice(0, firstBrace + 1)}${insertion}${content.slice(firstBrace + 1)}`;
};

const splitTopLevelArrayItems = (content: string): string[] => {
  const searchable = maskJsoncComments(content);
  const items: string[] = [];
  let depthSquare = 0;
  let depthCurly = 0;
  let depthParen = 0;
  let inString = false;
  let escaped = false;
  let segmentStart = 0;

  for (let index = 0; index < searchable.length; index += 1) {
    const char = searchable[index];

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
  const normalized = maskJsoncComments(item).trim();
  if (normalized === pluginPathLiteral) return true;
  const escapedLiteral = escapeForRegExp(pluginPathLiteral);
  const tuplePattern = new RegExp(`^\\[\\s*${escapedLiteral}(?:\\s*,|\\s*\\])`);
  return tuplePattern.test(normalized);
};

const commentsFromItem = (item: string): string[] => {
  const comments: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < item.length; index += 1) {
    const char = item[index];
    const next = item[index + 1];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "/" && next === "/") {
      const end = item.indexOf("\n", index);
      comments.push(item.slice(index, end < 0 ? item.length : end).trim());
      index = end < 0 ? item.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = item.indexOf("*/", index + 2);
      comments.push(item.slice(index, end < 0 ? item.length : end + 2).trim());
      index = end < 0 ? item.length : end + 1;
    }
  }
  return comments;
};

const pluginArrayContains = (
  content: string,
  pluginPathLiteral: string,
  property: "plugin" | "plugins",
): boolean => {
  const location = findPluginArray(content, property);
  if (!location) return false;
  const { openIndex, closeIndex } = location;
  return splitTopLevelArrayItems(content.slice(openIndex + 1, closeIndex)).some((item) =>
    isPluginEntryMatch(item, pluginPathLiteral),
  );
};

const removeFromPluginArray = (
  content: string,
  pluginPathLiteral: string,
  property: "plugin" | "plugins",
): string | null => {
  const location = findPluginArray(content, property);
  if (!location) return null;
  const { propertyIndex, openIndex, closeIndex } = location;

  const lineStart = content.lastIndexOf("\n", propertyIndex) + 1;
  const baseIndent = content.slice(lineStart, propertyIndex).match(/^\s*/)?.[0] ?? "";
  const itemIndent = `${baseIndent}  `;

  const inside = content.slice(openIndex + 1, closeIndex);
  const items = splitTopLevelArrayItems(inside);
  const retainedComments = items
    .filter((item) => isPluginEntryMatch(item, pluginPathLiteral))
    .flatMap(commentsFromItem);
  const nextItems = items.filter((item) => !isPluginEntryMatch(item, pluginPathLiteral));

  if (nextItems.length === items.length) return content;

  const commentBlock = retainedComments.map((comment) => `${itemIndent}${comment}`).join("\n");
  const itemBlock = nextItems.map((item) => `${itemIndent}${item}`).join(",\n");
  const rebuiltContent = [commentBlock, itemBlock].filter(Boolean).join("\n");
  const rebuiltInside = rebuiltContent ? `\n${rebuiltContent}\n${baseIndent}` : `\n${baseIndent}`;

  return `${content.slice(0, openIndex + 1)}${rebuiltInside}${content.slice(closeIndex)}`;
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
  let nextContent = content;
  let updated = false;

  if (!pluginArrayContains(nextContent, pluginPathLiteral, property)) {
    if (!findPluginArray(nextContent, property) && hasRootProperty(nextContent, property)) {
      throw new Error(
        `could not safely update ${configPath}; root ${property} property must be an array`,
      );
    }
    const withPlugin =
      addToPluginArray(nextContent, pluginPathLiteral, property) ??
      addPluginProperty(nextContent, pluginPathLiteral, property);

    if (withPlugin === null) {
      throw new Error(
        `could not safely update ${configPath}; add this path manually to your plugin array:\n${pluginPath}`,
      );
    }

    nextContent = withPlugin;
    updated = true;
  }

  if (!updated) {
    return false;
  }

  await writeFile(configPath, nextContent, "utf8");
  process.stdout.write(`Updated ${configPath} with plugin path.\n`);
  return true;
};

const runUninstall = async (
  configPath: string,
  pluginPath: string,
  property: "plugin" | "plugins",
): Promise<void> => {
  const pluginPathLiteral = JSON.stringify(pluginPath);
  const configStat = await lstatIfExists(configPath);

  if (!configStat) {
    process.stdout.write(`No changes needed. ${configPath} does not exist.\n`);
    return;
  }

  const content = await readFile(configPath, "utf8");
  const nextContent = removeFromPluginArray(content, pluginPathLiteral, property);

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
  let opencodeVersion: 1 | 2 = 1;

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
