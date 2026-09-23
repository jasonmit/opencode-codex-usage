import process from "node:process";
import { helpText, parseCliOptions, wantsJsonOutput, wantsPrettyOutput } from "./cli-options.js";
import { formatProbeOutput, probeQuota } from "./codex-usage-probe.js";
import { resolveSignalPath, writeSignalFileSafely } from "./codex-usage-signal.js";
import { probeOpenCode2Quota } from "./opencode2-cli-probe.js";
import { configurePlugins } from "./plugin-install.js";
import { statusState } from "./quota-format.js";

export const runCli = async (argv: string[] = process.argv.slice(2)): Promise<void> => {
  const options = parseCliOptions(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  if (options.install || options.uninstall) {
    await configurePlugins(options);
    return;
  }

  const snapshot =
    options.opencodeVersion === 2
      ? await probeOpenCode2Quota(options.retryCount)
      : await probeQuota({ retryCount: options.retryCount });
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
