# opencode-codex-usage

Check your Codex quota without leaving OpenCode. Ask the assistant, run `/codex-usage`, or get automatic quota alerts.

<img src="screenshot.png" alt="Codex quota toast in OpenCode" />

## Install

Connect your ChatGPT account with `/connect` in OpenCode, then:

```bash
npm install -g opencode-codex-usage
opencode-codex-usage --install
```

Restart OpenCode. Installation defaults to **OpenCode 2**.

## Check your usage

**Ask the assistant:**

> How much Codex quota do I have left, and when does it reset?

The assistant uses the `codex_usage` tool. Results cover Codex quota, not ChatGPT message limits or API billing.

**Get a quick toast:**

```text
/codex-usage
```

No assistant turn needed.

**Automatic alerts:** checks run on startup and every 10 minutes. By default, toasts appear when quota status worsens to warning or higher.

## From the terminal

```bash
opencode-codex-usage --pretty  # Readable usage bars
opencode-codex-usage --json    # JSON for scripts
opencode-codex-usage --help    # All options
```

Terminal queries require the plugin installed and `opencode` on your `PATH`.

## Settings & troubleshooting

For expired-token errors, reconnect your ChatGPT account with `/connect`.

<details>
<summary>Optional settings</summary>

Set environment variables before starting OpenCode:

| Variable                                 | Default       | Purpose                                                            |
| ---------------------------------------- | ------------- | ------------------------------------------------------------------ |
| `OPENCODE_CODEX_QUOTA_POLL_MS`           | `600000`      | Background check interval in milliseconds                          |
| `OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD`   | `warn`        | Alert threshold: `warn`, `critical`, `error`, `always`, or `never` |
| `OPENCODE_CODEX_QUOTA_TOAST_DURATION_MS` | `5000`        | Toast duration in milliseconds                                     |
| `OPENCODE_CODEX_QUOTA_RETRY_COUNT`       | `1`           | Transient failure retries (`0`–`2`)                                |
| `OPENCODE_CODEX_QUOTA_MODEL`             | Auto-detected | Override the probe model                                           |

Show only critical alerts:

```bash
OPENCODE_CODEX_QUOTA_TOAST_THRESHOLD=critical opencode
```

</details>

<details>
<summary>Upgrade, uninstall, or use OpenCode 1</summary>

To upgrade:

```bash
npm install -g opencode-codex-usage@latest
opencode-codex-usage --install
```

To remove the plugin and package:

```bash
opencode-codex-usage --uninstall
npm uninstall -g opencode-codex-usage
```

Restart OpenCode after changing the installation.

For **OpenCode 1**, add `--opencode 1` to install, uninstall, or usage commands.

</details>

## Development

```bash
npm install
npm run build
npm link
opencode-codex-usage --install
```

Restart OpenCode to load the local plugin. Before submitting changes:

```bash
npm test
npm run lint
npm run build
npm run format:check
```
