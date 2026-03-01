import { readFileSync } from "node:fs"
import { resolveAuthPath } from "./lib/auth-path.js"
import { durationText, extractCompletedUsageFromSse, healthLabel, val } from "./lib/quota-format.js"

type AuthFile = {
  openai?: {
    access?: string
    accountId?: string
  }
}

const AUTH_PATH = resolveAuthPath()
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"

const run = async (): Promise<void> => {
  let access = ""
  let accountId = ""

  try {
    const authRaw = readFileSync(AUTH_PATH, "utf8")
    const auth = JSON.parse(authRaw) as AuthFile
    access = auth.openai?.access ?? ""
    accountId = auth.openai?.accountId ?? ""
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error)
    console.log(`status=ERROR(auth) error=${detail.slice(0, 120)}`)
    return
  }

  const body = {
    model: "gpt-5.1-codex",
    instructions: "You are a coding assistant.",
    input: [{ role: "user", content: [{ type: "input_text", text: "reply ok" }] }],
    store: false,
    stream: true,
  }

  const response = await fetch(CODEX_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs",
      "chatgpt-account-id": accountId,
    },
    body: JSON.stringify(body),
  })

  const responseText = await response.text()

  if (!response.ok) {
    const detail = responseText.slice(0, 120).replace(/\n/g, " ").trim()
    console.log(`status=ERROR(${response.status}) error=${detail}`)
    return
  }

  const usage = extractCompletedUsageFromSse(responseText)
  const primaryUsed = val(response.headers, "x-codex-primary-used-percent")
  const secondaryUsed = val(response.headers, "x-codex-secondary-used-percent")
  const state = healthLabel(primaryUsed, secondaryUsed)
  const primaryReset = durationText(
    val(response.headers, "x-codex-primary-reset-after-seconds", ""),
  )
  const secondaryReset = durationText(
    val(response.headers, "x-codex-secondary-reset-after-seconds", ""),
  )
  const plan = val(response.headers, "x-codex-plan-type")
  const profile = val(response.headers, "x-codex-bengalfox-limit-name")
  const tokens = usage?.total_tokens ?? 0

  console.log(
    `status=${state}(${response.status}) plan=${plan} profile=${profile} used=${primaryUsed}%/${secondaryUsed}% reset=${primaryReset}/${secondaryReset} probe_tokens=${tokens}`,
  )
}

void run()
