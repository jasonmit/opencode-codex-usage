import { Plugin } from "@opencode/plugin/tui";
import {
  createQuotaMonitor,
  type QuotaMonitor,
  type QuotaMonitorOptions,
} from "./lib/codex-usage-monitor.js";
import { ProbeSnapshotSchema, type ProbeSnapshot } from "./lib/codex-usage-probe.js";
import { resolveSignalPath } from "./lib/codex-usage-signal.js";
import { CODEX_USAGE_RPC } from "./lib/opencode2-rpc.js";
import {
  resolvePollMs,
  resolveToastDurationMs,
  resolveToastThreshold,
} from "./lib/codex-usage-toast-plugin.js";

type QuotaProbe = () => Promise<ProbeSnapshot>;
type MonitorFactory = (options: QuotaMonitorOptions) => QuotaMonitor;

export const createOpenCode2TuiPlugin = (
  probe?: QuotaProbe,
  createMonitor: MonitorFactory = createQuotaMonitor,
) =>
  Plugin.define({
    id: "opencode-codex-usage",
    setup(ctx) {
      const quotaProbe: QuotaProbe =
        probe ??
        (async () => {
          const snapshot = await ctx.client.rpc(CODEX_USAGE_RPC).usage({});
          return ProbeSnapshotSchema.parse(snapshot);
        });
      const monitor = createMonitor({
        probe: quotaProbe,
        notify: (toast) => ctx.ui.toast.show(toast),
        logError: (message, detail) => {
          console.error(`[opencode-codex-usage] ${message}${detail ? `: ${detail}` : ""}`);
        },
        pollMs: resolvePollMs(),
        threshold: resolveToastThreshold(),
        durationMs: resolveToastDurationMs(),
        signalPath: resolveSignalPath(),
      });
      const releaseSlot = ctx.ui.slot({
        append: "app",
        render: () => {
          ctx.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "codex_usage",
                title: "Codex usage",
                description: "Show current Codex quota",
                group: "Codex",
                bind: "ctrl+x u",
                palette: true,
                slash: { name: "codex-usage" },
                run: () => monitor.refresh({ force: true, showFailure: true }),
              },
            ],
          }));
          return null;
        },
      });

      monitor.start();
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        monitor.stop();
        releaseSlot();
      };
    },
  });

export default createOpenCode2TuiPlugin();
