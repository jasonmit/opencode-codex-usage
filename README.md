# opencode-codex-usage

Lightweight tooling to surface Codex quota status inside OpenCode. 🚦

This project provides:

- a small probe that returns a compact one-line quota summary, and 🔎
- an OpenCode TUI plugin that turns that status into in-app toast notifications. 🍞

## ✨ What this project does

- Shows quota status in a compact format suitable for CLI and logs. 🧾
- Displays OpenCode TUI toast notifications for quota state. 🔔
- Supports a low-noise mode where background checks only toast on warning/error states. 🤫
- Works across Linux, macOS, and Windows. 🖥️

## 🗂️ Repository layout

- `codex-quota-probe.ts` - CLI probe entrypoint.
- `codex-quota-toast-plugin.ts` - OpenCode TUI toast plugin.
- `lib/` - shared formatting and path-resolution utilities.
- `tests/` - unit tests for core parsing/formatting logic.
- `dist/` - compiled JavaScript output.

## 🚀 Quick start

1. Install dependencies and build:

```bash
npm install
npm run build
```

2. Run the probe manually:

```bash
node ./dist/codex-quota-probe.js
```

3. Reference the built plugin in your OpenCode config (`plugin` array):

```json
"/absolute/path/to/opencode-codex-usage/dist/codex-quota-toast-plugin.js"
```

Restart OpenCode after plugin changes.

## 🧠 Behavior in OpenCode

The plugin checks quota on startup and periodically, then decides whether to show a toast.

Default behavior:

- background checks: toast only on warn/critical/error states ⚠️
- explicit quota command trigger: always toast 👆

This keeps normal sessions quiet while still surfacing actionable quota issues.

## ⚙️ Configuration

Auth path is auto-detected by OS:

- Linux: `~/.local/share/opencode/auth.json` (or `$XDG_DATA_HOME/opencode/auth.json`)
- macOS: `~/Library/Application Support/opencode/auth.json`
- Windows: `%LOCALAPPDATA%\\opencode\\auth.json`

Override with:

```bash
OPENCODE_AUTH_PATH=/custom/path/auth.json
```

## 🛠️ Development

Common commands:

```bash
npm run format
npm run format:check
npm run build
npm test
```

## 📝 Notes

- `dist/` is generated output; edit TypeScript sources in the repo root and `lib/`.
- The probe output format is intentionally compact so it is easy to parse and display.
