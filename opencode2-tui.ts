import { appendFileSync } from "node:fs";
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
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
} from "./lib/quota-settings.js";

type QuotaProbe = () => Promise<ProbeSnapshot>;

type MonitorFactory = (options: QuotaMonitorOptions) => QuotaMonitor;

export const createOpenCode2TuiPlugin = (
  probe?: QuotaProbe,
  createMonitor: MonitorFactory = createQuotaMonitor,
) =>
  Plugin.define({
    id: "opencode-codex-usage",
    setup(ctx) {
      const debugPath = process.env.OPENCODE_CODEX_QUOTA_DEBUG_FILE?.trim();
      let debugErrorReported = false;

      const recordPolling = (event: string) => {
        if (!debugPath) return;

        try {
          appendFileSync(debugPath, `${new Date().toISOString()} ${event}\n`, { mode: 0o600 });
        } catch (error: unknown) {
          if (debugErrorReported) return;
          debugErrorReported = true;
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`[opencode-codex-usage] polling diagnostic write failed: ${detail}`);
        }
      };

      const quotaProbe: QuotaProbe =
        probe ??
        (async () => {
          const snapshot = await ctx.client.rpc(CODEX_USAGE_RPC).usage({});

          return ProbeSnapshotSchema.parse(snapshot);
        });

      const monitorOptions = {
        probe: quotaProbe,
        notify: (toast) => ctx.ui.toast.show(toast),
        logError: (message, detail) => {
          console.error(`[opencode-codex-usage] ${message}${detail ? `: ${detail}` : ""}`);
        },
        pollMs: resolvePollMs(),
        threshold: resolveToastThreshold(),
        durationMs: resolveToastDurationMs(),
        signalPath: resolveSignalPath(),
      } satisfies QuotaMonitorOptions;

      const monitor = createMonitor({ ...monitorOptions, onDiagnostic: recordPolling });
      // Explicit checks have no timers and survive pauses of the automatic monitor.
      const manualMonitor = createMonitor(monitorOptions);
      let disposed = false;

      const releaseSlot = ctx.ui.slot({
        append: "app",
        render: () => {
          // Reading the cached selection reactively catches model switches as well as navigation.
          const selected = createMemo(() => {
            const route = ctx.ui.router.current();

            if (route.type !== "session") return undefined;
            const session = ctx.data.session.get(route.sessionID);

            if (!session) return undefined;

            return {
              sessionID: route.sessionID,
              providerID: session.model?.providerID,
              modelID: session.model?.id,
              location: { directory: session.location.directory },
            };
          });

          const [revision, invalidate] = createSignal(0);
          onCleanup(
            ctx.data.listen(({ details }) => {
              if (
                "location" in details &&
                details.location?.directory &&
                details.location.directory !== selected()?.location.directory
              )
                return;

              switch (details.type) {
                case "credential.updated":
                case "credential.switched":
                case "integration.updated":
                case "provider.updated":
                case "model.updated":
                case "config.updated":
                case "location.shutdown":
                case "server.connected":
                  invalidate((value) => value + 1);
              }
            }),
          );
          let polling = false;

          const setPolling = (enabled: boolean) => {
            if (polling === enabled) return;
            polling = enabled;

            if (enabled) monitor.start();
            else monitor.stop({ resetStatus: false });
          };

          onCleanup(() => setPolling(false));
          createEffect(() => {
            revision();
            const selection = selected();

            if (!selection || disposed) {
              setPolling(false);

              return;
            }

            if (selection.providerID && selection.providerID !== "openai") {
              setPolling(false);

              return;
            }

            let current = true;
            onCleanup(() => {
              current = false;
            });
            void ctx.client
              .rpc(CODEX_USAGE_RPC)
              .pollingEligible({ sessionID: selection.sessionID }, { location: selection.location })
              .then((eligible) => {
                if (!current || disposed) return;
                setPolling(eligible);
              })
              .catch((error: unknown) => {
                if (!current || disposed) return;
                setPolling(false);
                const detail = error instanceof Error ? error.message : String(error);
                console.error(`[opencode-codex-usage] polling eligibility failed: ${detail}`);
              });
          });
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
                run: () => manualMonitor.refresh({ force: true, showFailure: true }),
              },
            ],
          }));

          return null;
        },
      });

      return () => {
        if (disposed) return;
        disposed = true;
        monitor.stop();
        manualMonitor.stop();
        releaseSlot();
      };
    },
  });

export default createOpenCode2TuiPlugin();
