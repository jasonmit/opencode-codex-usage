import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseProbeLine, statusState, type ProbeResult } from "./lib/quota-format.js"

const PROBE_PATH = join(dirname(fileURLToPath(import.meta.url)), "codex_quota_probe.js")
const POLL_MS = 10 * 60 * 1000
const SIGNAL_FILENAME = ".codex-quota-trigger"

type ToastVariant = "info" | "warning" | "error"

type ShellCommand = {
  text: () => Promise<string>
}

type ShellTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => ShellCommand

type ToastPayload = {
  body: {
    title: string
    message: string
    variant: ToastVariant
    duration: number
  }
}

type Client = {
  tui: {
    showToast: (payload: ToastPayload) => Promise<unknown>
  }
}

type PluginEvent = {
  type: string
  properties?: {
    name?: string
    file?: string
  }
}

type PluginContext = {
  $: ShellTemplateTag
  client: Client
  worktree: string
}

const toastVariantForStatus = (rawStatus: string | undefined): ToastVariant => {
  const state = statusState(rawStatus)
  if (state === "ERROR" || state === "CRITICAL") return "error"
  if (state === "WARN" || state === "UNKNOWN") return "warning"
  return "info"
}

const shouldToastForBackground = (rawStatus: string | undefined): boolean => {
  const state = statusState(rawStatus)
  return state === "WARN" || state === "CRITICAL" || state === "ERROR"
}

const messageFromParsed = (parsed: ProbeResult): string => {
  const state = statusState(parsed.status)
  const used = parsed.used || "-/-"
  const reset = parsed.reset || "-/-"
  return `Quota ${state} | used ${used} | reset ${reset}`
}

export const CodexQuotaToastPlugin = async ({ $, client, worktree }: PluginContext) => {
  let running = false
  const signalPath = `${worktree.replace(/\/$/, "")}/${SIGNAL_FILENAME}`

  const isSignalFile = (filePath: string | undefined): boolean => {
    const normalized = String(filePath || "").replace(/\\/g, "/")
    return (
      normalized === signalPath ||
      normalized === SIGNAL_FILENAME ||
      normalized.endsWith(`/${SIGNAL_FILENAME}`)
    )
  }

  const runProbe = async ({ force = false }: { force?: boolean } = {}): Promise<void> => {
    if (running) return
    running = true

    try {
      const output = await $`node ${PROBE_PATH}`.text()
      const line =
        String(output || "")
          .trim()
          .split(/\r?\n/)
          .pop() || ""

      const parsed = parseProbeLine(line)
      if (!force && !shouldToastForBackground(parsed.status)) {
        return
      }
      await client.tui.showToast({
        body: {
          title: "Codex quota",
          message: messageFromParsed(parsed),
          variant: toastVariantForStatus(parsed.status),
          duration: 3500,
        },
      })
    } catch (error: unknown) {
      const detail = String(error instanceof Error ? error.message : error).slice(0, 160)
      await client.tui.showToast({
        body: {
          title: "Codex quota",
          message: `Probe failed: ${detail}`,
          variant: "error",
          duration: 4000,
        },
      })
    } finally {
      running = false
    }
  }

  setInterval(() => {
    void runProbe()
  }, POLL_MS)

  void runProbe()

  return {
    event: async ({ event }: { event: PluginEvent }) => {
      if (event.type === "server.connected") {
        void runProbe()
      }

      if (event.type === "command.executed" && event.properties?.name === "codex-quota") {
        void runProbe({ force: true })
      }

      if (event.type === "file.watcher.updated" && isSignalFile(event.properties?.file)) {
        void runProbe()
      }
    },
  }
}

export default CodexQuotaToastPlugin
