import assert from "node:assert/strict";
import test from "node:test";
import { formatProbeOutput } from "../lib/codex-usage-probe.js";

test("formatProbeOutput returns compact JSON by default", () => {
  const line = formatProbeOutput({ status: "ok", statusCode: 200 });
  assert.equal(line, '{"status":"ok","statusCode":200}');
});

test("formatProbeOutput returns formatted JSON when requested", () => {
  const line = formatProbeOutput({ status: "ok", statusCode: 200 }, { printJson: true });
  assert.match(line, /\{\n\s+"status": "ok",\n\s+"statusCode": 200\n\}/);
});

test("formatProbeOutput returns chart-like output in pretty mode", () => {
  const pretty = formatProbeOutput(
    {
      status: "warn",
      statusCode: 200,
      plan: "plus",
      profile: "default",
      used: { primary: 81, secondary: 9 },
      reset: { primary: "1h0m", secondary: "7d0h" },
      windowMinutes: { primary: 300, secondary: 10080 },
    },
    { pretty: true },
  );

  assert.match(pretty, /codex quota:\s+WARN\s+⚠️/);
  assert.match(pretty, /status code:\s+200/);
  assert.match(pretty, /plan \/ profile:\s+plus \/ default/);
  assert.match(pretty, /5h window:\s+\[#/);
  assert.match(pretty, /7d window:\s+\[#/);
  assert.match(pretty, /⏳\s+1h0m/);
});

test("formatProbeOutput pretty mode shows probe errors", () => {
  const pretty = formatProbeOutput(
    {
      status: "error",
      statusCode: "auth",
      error: "missing access token",
    },
    { pretty: true },
  );

  assert.match(pretty, /codex quota probe:\s+ERROR\s+🚨/);
  assert.match(pretty, /status code:\s+auth/);
  assert.match(pretty, /error:\s+missing access token/);
});

test("formatProbeOutput aligns bar columns for row labels", () => {
  const pretty = formatProbeOutput(
    {
      status: "warn",
      used: { primary: 81, secondary: 9 },
      reset: { primary: "1h0m", secondary: "7d0h" },
      windowMinutes: { primary: 300, secondary: 15 },
    },
    { pretty: true },
  );

  const lines = pretty.split("\n");
  const firstBar = lines[3]?.indexOf("[") ?? -1;
  const secondBar = lines[4]?.indexOf("[") ?? -1;
  assert.equal(firstBar, secondBar);
});

test("formatProbeOutput aligns values for metadata rows", () => {
  const pretty = formatProbeOutput(
    {
      status: "ok",
      statusCode: 200,
      plan: "plus",
      profile: "default",
      used: { primary: 50, secondary: 25 },
      reset: { primary: "1h0m", secondary: "7d0h" },
      windowMinutes: { primary: 300, secondary: 10080 },
    },
    { pretty: true },
  );

  const lines = pretty.split("\n");
  const quotaValueStart = lines[0]?.indexOf("OK") ?? -1;
  const statusValueStart = lines[1]?.indexOf("200") ?? -1;
  const planValueStart = lines[2]?.indexOf("plus / default") ?? -1;
  assert.equal(quotaValueStart, statusValueStart);
  assert.equal(statusValueStart, planValueStart);
});
