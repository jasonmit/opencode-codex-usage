import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { CliOptions } from "./cli-options.js";
import { addPluginEntry, parseConfig, removePluginEntries } from "./config-edit.js";
import { lstatIfExists } from "./file-status.js";

const globalConfigDirectory = (): string =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode");

const resolveTuiConfigPath = (configPath: string, opencodeVersion: 1 | 2): string => {
  return opencodeVersion === 2
    ? path.join(globalConfigDirectory(), "cli.json")
    : path.join(path.dirname(configPath), "tui.json");
};

const pluginPathFromModule = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));

  return path.resolve(moduleDir, "..", "..");
};

type ConfigUpdate = {
  configPath: string;
  content?: string;
  message?: string;
};

const prepareInstall = async (
  configPath: string,
  pluginPath: string,
  property: "plugin" | "plugins",
  preparedContent?: string,
): Promise<ConfigUpdate> => {
  const pluginStat = await lstatIfExists(pluginPath);

  if (!pluginStat) {
    throw new Error(
      `built plugin not found at ${pluginPath}; run "npm run build" first, then rerun opencode-codex-usage --install`,
    );
  }

  const pluginPathLiteral = JSON.stringify(pluginPath);
  const configStat = await lstatIfExists(configPath);

  if (!configStat && preparedContent === undefined) {
    const freshConfig = `{
  "${property}": [
    ${pluginPathLiteral}
  ]
}\n`;

    return {
      configPath,
      content: freshConfig,
      message: `Created ${configPath} with plugin path.\n`,
    };
  }

  const content = preparedContent ?? (await readFile(configPath, "utf8"));
  const nextContent = addPluginEntry(content, configPath, pluginPath, property);

  if (nextContent === content) return { configPath };
  parseConfig(nextContent, configPath);

  return {
    configPath,
    content: nextContent,
    message: `Updated ${configPath} with plugin path.\n`,
  };
};

const prepareUninstall = async (
  configPath: string,
  pluginPath: string,
  property: "plugin" | "plugins",
  preparedContent?: string,
): Promise<ConfigUpdate> => {
  const configStat = await lstatIfExists(configPath);

  if (!configStat) {
    return { configPath, message: `No changes needed. ${configPath} does not exist.\n` };
  }

  const content = preparedContent ?? (await readFile(configPath, "utf8"));
  const nextContent = removePluginEntries(content, configPath, pluginPath, property);
  parseConfig(nextContent, configPath);

  if (nextContent === content) {
    return { configPath, message: `No changes needed. Plugin path is not configured.\n` };
  }

  return {
    configPath,
    content: nextContent,
    message: `Updated ${configPath} by removing plugin path.\n`,
  };
};

export const configurePlugins = async (
  options: Pick<CliOptions, "configPath" | "opencodeVersion" | "install">,
): Promise<void> => {
  const defaultConfigPath = path.join(globalConfigDirectory(), "opencode.jsonc");
  const configPath = options.configPath ? path.resolve(options.configPath) : defaultConfigPath;
  const tuiConfigPath = resolveTuiConfigPath(configPath, options.opencodeVersion);
  const isV2 = options.opencodeVersion === 2;
  const property = isV2 ? "plugins" : "plugin";
  const packageRoot = pluginPathFromModule();
  const serverPlugin = isV2 ? path.join(packageRoot, "opencode2-plugin") : packageRoot;
  const tuiPlugin = isV2 ? path.join(packageRoot, "opencode2-tui-plugin") : serverPlugin;
  const prepare = options.install ? prepareInstall : prepareUninstall;
  // Validate both inputs and their edits before creating directories or writing either file.
  const serverUpdate = await prepare(configPath, serverPlugin, property);

  const tuiUpdate = await prepare(
    tuiConfigPath,
    tuiPlugin,
    property,
    configPath === tuiConfigPath ? serverUpdate.content : undefined,
  );

  const updates = [serverUpdate, tuiUpdate];

  for (const update of updates) {
    if (update.content === undefined) continue;
    await mkdir(path.dirname(update.configPath), { recursive: true });
    await writeFile(update.configPath, update.content, "utf8");
  }

  if (options.install && updates.every((update) => update.content === undefined)) {
    process.stdout.write(`No changes needed. Server and TUI plugins are already configured.\n`);
  }

  for (const update of updates) {
    if (update.message) process.stdout.write(update.message);
  }
};
