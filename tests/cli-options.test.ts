import assert from "node:assert/strict";
import { parseCliOptions } from "#lib/cli-options.js";
import { test } from "./test.ts";

test("parseCliOptions defaults to silent output and OpenCode 2", () => {
  assert.deepEqual(parseCliOptions([]), {
    help: false,
    noNotify: false,
    pretty: false,
    printJson: false,
    retryCount: undefined,
    install: false,
    uninstall: false,
    configPath: undefined,
    opencodeVersion: 2,
  });
});

test("parseCliOptions recognizes output and notify flags", () => {
  const options = parseCliOptions(["--verbose", "--no-notify"]);
  assert.equal(options.printJson, true);
  assert.equal(options.noNotify, true);
  assert.equal(parseCliOptions(["--json"]).printJson, true);
});

test("parseCliOptions recognizes pretty output flag", () => {
  const options = parseCliOptions(["--pretty"]);
  assert.equal(options.pretty, true);
  assert.equal(options.printJson, true);
});

test("parseCliOptions recognizes install and setup alias flags", () => {
  assert.equal(parseCliOptions(["--install"]).install, true);
  assert.equal(parseCliOptions(["--setup"]).install, true);
});

test("parseCliOptions recognizes uninstall flag", () => {
  assert.equal(parseCliOptions(["--uninstall"]).uninstall, true);
});

test("parseCliOptions accepts only explicit OpenCode versions", () => {
  assert.equal(parseCliOptions(["--opencode", "2"]).opencodeVersion, 2);
  assert.equal(parseCliOptions(["--opencode=1"]).opencodeVersion, 1);
  assert.throws(() => parseCliOptions(["--opencode"]), /requires a value/);
  assert.throws(() => parseCliOptions(["--opencode", "3"]), /must be 1 or 2/);
});

test("parseCliOptions recognizes help flags", () => {
  assert.equal(parseCliOptions(["--help"]).help, true);
  assert.equal(parseCliOptions(["-h"]).help, true);
});

test("parseCliOptions accepts setup config path", () => {
  assert.equal(
    parseCliOptions(["--install", "--config", "./tmp/opencode.jsonc"]).configPath,
    "./tmp/opencode.jsonc",
  );
  assert.equal(
    parseCliOptions(["--uninstall", "--config=/tmp/opencode.jsonc"]).configPath,
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

test("parseCliOptions rejects conflicting install and uninstall flags", () => {
  assert.throws(() => parseCliOptions(["--install", "--uninstall"]), /cannot be combined/);
});
