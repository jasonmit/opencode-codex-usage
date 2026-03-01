import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_RELATIVE_PATH = path.join("dist", "codex-quota-toast-plugin.js");

const errorAndExit = (message) => {
  console.error(message);
  process.exit(1);
};

const findMatchingBracket = (text, openIndex) => {
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

const addToPluginArray = (content, pluginPathLiteral) => {
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

const addPluginProperty = (content, pluginPathLiteral) => {
  const firstBrace = content.indexOf("{");
  if (firstBrace < 0) return null;

  const insertion = `\n  "plugin": [\n    ${pluginPathLiteral}\n  ],`;
  return `${content.slice(0, firstBrace + 1)}${insertion}${content.slice(firstBrace + 1)}`;
};

const defaultConfigPath = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc");
const configArg = process.argv.find((arg) => arg.startsWith("--config="));
const configPath = configArg ? configArg.slice("--config=".length) : defaultConfigPath;
const pluginPath = path.resolve(process.cwd(), PLUGIN_RELATIVE_PATH);

if (!existsSync(pluginPath)) {
  errorAndExit(
    `Built plugin not found at ${pluginPath}. Run \"npm run build\" first, then rerun this setup script.`,
  );
}

const pluginPathLiteral = JSON.stringify(pluginPath);

await mkdir(path.dirname(configPath), { recursive: true });

if (!existsSync(configPath)) {
  const freshConfig = `{
  "plugin": [
    ${pluginPathLiteral}
  ]
}\n`;
  await writeFile(configPath, freshConfig, "utf8");
  console.log(`Created ${configPath} and added plugin path.`);
  process.exit(0);
}

const content = await readFile(configPath, "utf8");

if (content.includes(pluginPathLiteral)) {
  console.log("Plugin path already configured. No changes made.");
  process.exit(0);
}

let nextContent = addToPluginArray(content, pluginPathLiteral);
if (nextContent === null) {
  nextContent = addPluginProperty(content, pluginPathLiteral);
}

if (nextContent === null) {
  errorAndExit(
    `Could not safely update ${configPath}. Add this path manually to your plugin array:\n${pluginPath}`,
  );
}

await writeFile(configPath, nextContent, "utf8");
console.log(`Updated ${configPath} with plugin path.`);
