import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const root = path.resolve(import.meta.dirname, "../../..");

const cli = path.resolve(import.meta.dirname, "../../bin/opencode-codex-usage.js");

export const serverPlugin = path.join(root, "opencode2-plugin");

export const tuiPlugin = path.join(root, "opencode2-tui-plugin");

export const fixture = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-cli-integration-"));
  const configHome = path.join(directory, "config");

  const env = {
    ...process.env,
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: path.join(directory, "data"),
    OPENCODE_AUTH_PATH: "",
    OPENCODE_CODEX_USAGE_SIGNAL_PATH: path.join(directory, "quota.signal"),
  };

  const run = (args: string[], environment = env) =>
    spawnSync(process.execPath, ["--conditions=opencode-codex-usage-test", cli, ...args], {
      env: environment,
      encoding: "utf8",
      cwd: directory,
    });

  return {
    directory,
    configHome,
    env,
    run,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

export const fakeOpenCode = async (
  state: Awaited<ReturnType<typeof fixture>>,
  response: string,
  exitCode = 0,
) => {
  const bin = path.join(state.directory, "bin");
  const calls = path.join(state.directory, "calls.json");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "opencode"),
    `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));
process.${exitCode ? "stderr" : "stdout"}.write(${JSON.stringify(response)});
process.exitCode = ${exitCode};
`,
    { mode: 0o755 },
  );

  return {
    env: { ...state.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    calls: async () => z.array(z.string()).parse(JSON.parse(await readFile(calls, "utf8"))),
  };
};
