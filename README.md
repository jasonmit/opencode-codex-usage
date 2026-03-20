# opencode-codex-usage

Small OpenCode plugin for Codex quota visibility.

Instead of checking the web dashboard, you get quota toasts directly in OpenCode.

## What it does

- Shows Codex quota status as OpenCode toasts.
- Runs a background check on startup and every 10 minutes.
- Keeps noise low: background checks only notify when quota reaches the configured threshold (`warn` by default, so `warn`/`critical`/`error`).
- Includes JSON output mode for scripts and debugging.

## Quick start

### Option A: install from npm (recommended)

```bash
npm install -g opencode-codex-usage
opencode-codex-usage --setup
```

Then restart OpenCode.

### Option B: run with npx (no global install)

```bash
npx opencode-codex-usage --setup
```

Then restart OpenCode.

### Option C: local repo (development)

1. Build:

```bash
npm install
npm run build
```

2. Link and auto-configure OpenCode:

```bash
npm link
opencode-codex-usage --setup
```

3. Restart OpenCode.

Manual plugin path (if you prefer editing config directly):

```json
"<repo>/dist/index.js"
```

## Screenshot

<img src="screenshot.png?cache=20260301" alt="Codex quota toast in OpenCode" width="80%" />

## CLI commands

The plugin registers a `/codex-usage` slash command and handles it in plugin hooks.
This means quota checks run locally and the command is handled silently without an assistant turn.

You can still run `opencode-codex-usage` directly when you want an immediate toast trigger from a shell.

After setup verify end-to-end:

```bash
OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD=always opencode
/codex-usage
```

Use `/codex-usage` or `opencode-codex-usage` to verify the end-to-end toast flow immediately (no agent invocation).

Flags for `opencode-codex-usage`:

- `-h` or `--help` - show CLI usage and available flags.
- `--json` or `--verbose` - print JSON snapshot to stdout on success.
- `--pretty` - show a human-friendly quota view with ASCII usage bars.
- `--no-notify` - skip writing the trigger file.
- `--setup` - update OpenCode config with plugin path only.
- `--config <path>` - with `--setup`, use a non-default OpenCode config path.
- On error, JSON is written to stderr and the process exits non-zero.

Remove global install:

```bash
npm uninstall -g opencode-codex-usage
```

Remove local link:

```bash
npm unlink -g opencode-codex-usage
```

## Behavior

- Background checks run on startup and on interval.
- Background checks trigger a toast only when status meets the configured threshold.
- Manual triggers use a per-user signal file in the system temp directory, so `opencode-codex-usage` works from any folder.
- Window labels use API-provided window minutes when available (for example `5h window`, `7d window`), otherwise fallback to `window A` / `window B`.

## Configuration

Auth file is auto-detected by OS:

- Linux: `~/.local/share/opencode/auth.json` (or `$XDG_DATA_HOME/opencode/auth.json`)
- macOS: `~/Library/Application Support/opencode/auth.json`
- Windows: `%LOCALAPPDATA%\\opencode\\auth.json`

Override auth path:

```bash
OPENCODE_AUTH_PATH=/custom/path/auth.json
```

Set polling interval (milliseconds):

```bash
OPENCODE_CODEX_QUOTA_POLL_MS=120000
```

Default is `600000` (10 minutes). Invalid or non-positive values fall back to default.

Override trigger signal file path (optional):

```bash
OPENCODE_CODEX_USAGE_SIGNAL_PATH=/tmp/opencode-codex-usage.trigger
```

Set background toast threshold:

```bash
OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD=critical
```

Allowed values: `warn` (default), `critical`, `error`, `always`, `never`.

Set toast duration (milliseconds):

```bash
OPENCODE_CODEX_QUOTA_TOAST_DURATION_MS=5000
```

Default is `5000`. Invalid or non-positive values fall back to default.

## Probe output

The probe prints one JSON object (`ProbeSnapshot`) per run.

Common keys:

- `status` (for example `ok`, `warn`, `error`)
- `statusCode` (for example `200`, `500`, `auth`, `network`, `timeout`)
- `used` (`primary`/`secondary` percent)
- `reset` (`primary`/`secondary` reset duration)
- `windowMinutes` (`primary`/`secondary` window length in minutes, when available)
- `plan`, `profile`, `probeTokens`, `error`

Example:

```json
{
  "status": "warn",
  "statusCode": 200,
  "plan": "plus",
  "profile": "default",
  "used": { "primary": 81, "secondary": 9 },
  "reset": { "primary": "1h0m", "secondary": "7d0h" },
  "windowMinutes": { "primary": 300, "secondary": 10080 },
  "probeTokens": 10
}
```

## Development

```bash
npm run build
npm test
npm run format
```

Auto-configure OpenCode with local plugin path:

```bash
opencode-codex-usage --setup
```
