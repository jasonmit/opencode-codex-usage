import assert from "node:assert/strict";
import test from "node:test";
import { parseCliOptions } from "../lib/codex-usage-cli.js";

test("parseCliOptions uses silent-json defaults", () => {
  assert.deepEqual(parseCliOptions([]), {
    help: false,
    noNotify: false,
    pretty: false,
    printJson: false,
    retryCount: undefined,
    setup: false,
    setupConfigPath: undefined,
  });
});

test("parseCliOptions recognizes output and notify flags", () => {
  assert.deepEqual(parseCliOptions(["--verbose", "--no-notify"]), {
    help: false,
    noNotify: true,
    pretty: false,
    printJson: true,
    retryCount: undefined,
    setup: false,
    setupConfigPath: undefined,
  });
  assert.deepEqual(parseCliOptions(["--json"]), {
    help: false,
    noNotify: false,
    pretty: false,
    printJson: true,
    retryCount: undefined,
    setup: false,
    setupConfigPath: undefined,
  });
});

test("parseCliOptions recognizes pretty output flag", () => {
  assert.deepEqual(parseCliOptions(["--pretty"]), {
    help: false,
    noNotify: false,
    pretty: true,
    printJson: true,
    retryCount: undefined,
    setup: false,
    setupConfigPath: undefined,
  });
});

test("parseCliOptions recognizes setup flag", () => {
  assert.deepEqual(parseCliOptions(["--setup"]), {
    help: false,
    noNotify: false,
    pretty: false,
    printJson: false,
    retryCount: undefined,
    setup: true,
    setupConfigPath: undefined,
  });
});

test("parseCliOptions recognizes help flags", () => {
  assert.equal(parseCliOptions(["--help"]).help, true);
  assert.equal(parseCliOptions(["-h"]).help, true);
});

test("parseCliOptions accepts setup config path", () => {
  assert.equal(
    parseCliOptions(["--setup", "--config", "./tmp/opencode.jsonc"]).setupConfigPath,
    "./tmp/opencode.jsonc",
  );
  assert.equal(
    parseCliOptions(["--setup", "--config=/tmp/opencode.jsonc"]).setupConfigPath,
    "/tmp/opencode.jsonc",
  );
});

test("parseCliOptions rejects missing config value", () => {
  assert.throws(() => parseCliOptions(["--config"]), /requires a value/);
});

test("parseCliOptions accepts retry count", () => {
  assert.equal(parseCliOptions(["--retry", "2"]).retryCount, 2);
  assert.equal(parseCliOptions(["--retry=0"]).retryCount, 0);
});

test("parseCliOptions rejects invalid retry count", () => {
  assert.throws(() => parseCliOptions(["--retry"]), /requires a value/);
  assert.throws(() => parseCliOptions(["--retry", "abc"]), /integer between 0 and 2/);
  assert.throws(() => parseCliOptions(["--retry", "9"]), /between 0 and 2/);
});
