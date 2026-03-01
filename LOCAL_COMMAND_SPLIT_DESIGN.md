# Local Fast Path for `/codex-quota`

This document proposes a minimal command-routing split so `/codex-quota` runs as a local command (no agent hop), while all other slash commands keep using the existing agent pipeline.

## Goal

- Keep slash command UX unchanged for users.
- Reduce `/codex-quota` latency and complexity.
- Avoid wide architectural changes.

## Current Problem

`/codex-quota` is a status/probe operation, but it currently travels through the same agent path as reasoning-heavy commands. This adds avoidable overhead (extra latency and extra moving parts).

## Proposed Minimal Split

1. Add a local slash-command registry in the CLI dispatcher.
2. Register only `codex-quota` in that registry.
3. Short-circuit to local execution when command is `codex-quota`.
4. Keep the existing agent path as-is for all other commands.

Pseudo-logic:

```ts
const isLocalQuotaEnabled = process.env.OPENCODE_LOCAL_CODEX_QUOTA !== "0";
const handler = isLocalQuotaEnabled ? localSlashCommands[cmd.name] : undefined;

if (handler) {
  return await handler(ctx, cmd.args);
}

return await runAgentCommand(ctx, rawInput);
```

## Local `/codex-quota` Handler Contract

- Reuse existing probe logic (`probeQuota` / `probeQuotaLine`).
- Return the same structured JSON snapshot shape.
- Render compact human-friendly output by default.
- Support `--json` to print JSON only.
- Map known probe failures (`auth`, `network`, `timeout`) to stable non-zero exit codes.

## Compatibility

- Preserve toast behavior by emitting the same trigger/event mechanism already used by the plugin path.
- Keep backward compatibility in message formatting where possible.

## Rollout and Safety

- Guard with env flag: `OPENCODE_LOCAL_CODEX_QUOTA`.
  - default: enabled
  - set to `0` to force legacy agent route
- Add lightweight telemetry/logging:
  - `codex_quota.path=local|agent`
  - `codex_quota.local.ms`

## Test Plan

1. Dispatcher routes `/codex-quota` to local handler.
2. Dispatcher routes non-quota slash commands to agent path.
3. Local handler returns expected output for success and error states.
4. Local handler supports `--json` format.
5. Integration: local path does not call agent transport.

## Why This Is Minimal

- Single targeted branch in command dispatch.
- Reuses current probe implementation.
- No behavior changes for other slash commands.
- Fast rollback via one env flag.
