import assert from "node:assert/strict";
import { test } from "./test.ts";

test("test aliases resolve to the freshly compiled test tree", () => {
  assert.equal(
    import.meta.resolve("#lib/cli-options.js"),
    new URL("../lib/cli-options.js", import.meta.url).href,
  );
  assert.equal(import.meta.resolve("#root/index.js"), new URL("../index.js", import.meta.url).href);
});
