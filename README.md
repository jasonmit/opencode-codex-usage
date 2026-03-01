# opencode-codex-usage

Lightweight tooling to surface Codex quota status inside OpenCode so you do not have to keep checking the web usage dashboard.

This is a personal utility that I open-sourced in case it is useful to others.

This project provides:

- an OpenCode TUI plugin that surfaces Codex quota status as in-app toast notifications, and
- an optional probe utility that returns the same status as structured JSON.

## ✨ What this project does

- Replaces routine web usage dashboard checks with in-app quota visibility.
- Displays OpenCode TUI toast notifications for quota state.
- Supports a low-noise mode where background checks only toast on warning/error states.
- Works across Linux, macOS, and Windows.
- Includes an optional JSON probe output for scripting and diagnostics.

## 🗂️ Repository layout

- `codex-quota-toast-plugin.ts` - OpenCode TUI toast plugin.
- `codex-quota-probe.ts` - optional probe utility entrypoint.
- `lib/` - shared formatting and path-resolution utilities.
- `tests/` - unit tests for core parsing/formatting logic.
- `dist/` - compiled JavaScript output.

## 🚀 Quick start

1. Install dependencies and build:

```bash
npm install
npm run build
```

2. Reference the built plugin in your OpenCode config (`plugin` array):

```json
"/absolute/path/to/opencode-codex-usage/dist/codex-quota-toast-plugin.js"
```

3. (Optional) Run the probe manually:

```bash
node ./dist/codex-quota-probe.js
```

Restart OpenCode after plugin changes.

## 📤 Probe output

The probe returns one JSON object per run.

Shape (`ProbeSnapshot`):

- `status` - health label with HTTP context (for example `OK(200)`, `WARN(200)`, `ERROR(auth)`).
- `used` - usage percentages per window object (`{"primary": <percent|null>, "secondary": <percent|null>}`).
- `reset` - reset duration per window object (`{"primary": <duration|null>, "secondary": <duration|null>}`), for example `{"primary":"1h0m","secondary":"7d0h"}`.
- `windowMinutes` - optional window-size object from response headers (`{"primary": <minutes|null>, "secondary": <minutes|null>}`), for example `{"primary":300,"secondary":10080}`.
- `plan` - plan type header value when present.
- `profile` - profile/limit name header value when present.
- `probeTokens` - token usage from SSE `response.completed.usage.total_tokens`.
- `error` - short error detail; present on failures.

Success example:

```json
{
  "status": "WARN(200)",
  "plan": "plus",
  "profile": "default",
  "used": { "primary": 81, "secondary": 9 },
  "reset": { "primary": "1h0m", "secondary": "7d0h" },
  "windowMinutes": { "primary": 300, "secondary": 10080 },
  "probeTokens": 10
}
```

Error example:

```json
{ "status": "ERROR(auth)", "error": "missing access token" }
```

Compatibility notes:

- Consumers should tolerate missing fields on error responses.
- New fields may be added over time; existing keys are kept stable.

## 📸 Usage screenshot

![Codex quota toast in OpenCode](screenshot.png)

## 🧠 Behavior in OpenCode

The plugin checks quota on startup and periodically, then decides whether to show a toast.

Default behavior:

- background checks: toast only on warn/critical/error states ⚠️
- explicit quota command trigger: always toast
- toast text uses dynamic window labels from API headers when available (for example `5h window` and `7d window`) and shows each window on its own line; otherwise it falls back to neutral labels `window A` and `window B`

This keeps normal sessions quiet while still surfacing actionable quota issues.

## ⚙️ Configuration

Auth path is auto-detected by OS:

- Linux: `~/.local/share/opencode/auth.json` (or `$XDG_DATA_HOME/opencode/auth.json`)
- macOS: `~/Library/Application Support/opencode/auth.json`
- Windows: `%LOCALAPPDATA%\\opencode\\auth.json`

Before using this plugin, make sure OpenCode auth has been bootstrapped so that `auth.json` exists.
If you are using Codex auth setup tooling, a common option is:

- `https://github.com/numman-ali/opencode-openai-codex-auth`

Override with:

```bash
OPENCODE_AUTH_PATH=/custom/path/auth.json
```

Configure background quota polling interval (milliseconds):

```bash
OPENCODE_CODEX_QUOTA_POLL_MS=120000
```

Default is `600000` (10 minutes). Invalid or non-positive values fall back to the default.

Configure background toast threshold:

```bash
OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD=critical
```

Allowed values are `warn` (default), `critical`, `error`, `always`, and `never`.

Troubleshooting:

- If you see `status=ERROR(auth)`, your OpenCode auth file is missing or invalid. Bootstrap auth first (for example via `https://github.com/numman-ali/opencode-openai-codex-auth`), then retry.

## 🛠️ Development

Common commands:

```bash
npm run format
npm run format:check
npm run build
npm test
```

## 📦 Distribution

Build locally:

```bash
npm install
npm run build
```

Auto-configure OpenCode with your local plugin path:

```bash
npm run setup
```

This updates `~/.config/opencode/opencode.jsonc` and adds the built plugin path to the `plugin` array.

If you prefer to configure manually, reference the built plugin from your checkout in OpenCode config:

1. Find your repo's absolute path.

```bash
pwd
```

2. Add the built plugin file to your OpenCode config `plugin` array.

```json
{
  "plugin": ["/absolute/path/to/opencode-codex-usage/dist/codex-quota-toast-plugin.js"]
}
```

3. Replace `/absolute/path/to/opencode-codex-usage` with your real path from `pwd`, then restart OpenCode.

## 📝 Notes

- `dist/` is generated output; edit TypeScript sources in the repo root and `lib/`.
- The probe output is structured JSON intended for machine parsing and display.
