import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  type ModificationOptions,
  type ParseError,
} from "jsonc-parser";
import { z } from "zod";

const configSchema = z.record(z.string(), z.unknown());

const modificationOptions = {
  formattingOptions: {
    insertSpaces: true,
    tabSize: 2,
    eol: "\n",
  },
} satisfies ModificationOptions;

export const parseConfig = (content: string, configPath: string): Record<string, unknown> => {
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
  if (entry === pluginPath || (Array.isArray(entry) && entry[0] === pluginPath)) return true;
  const result = z.object({ package: z.string() }).safeParse(entry);
  return result.success && result.data.package === pluginPath;
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

export const addPluginEntry = (
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

export const removePluginEntries = (
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

  return matchingIndexes.reduce((nextContent, index) => {
    const root = parseTree(nextContent);
    if (!root) throw new Error(`could not parse ${configPath}`);
    const array = findNodeAtLocation(root, [property]);
    const node = array?.children?.[index];
    const previous = array?.children?.[index - 1];
    // jsonc-parser 3.3.1 leaves the last character of compact final items behind.
    // Use AST bounds for that case, preserving the original closing bracket.
    if (node && previous && index === (array?.children?.length ?? 0) - 1) {
      const offset = previous.offset + previous.length;
      return applyEdits(nextContent, [
        { offset, length: node.offset + node.length - offset, content: "" },
      ]);
    }
    return applyEdits(
      nextContent,
      modify(nextContent, [property, index], undefined, modificationOptions),
    );
  }, content);
};
