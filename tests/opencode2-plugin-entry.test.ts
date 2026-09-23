import { Plugin } from "@opencode/plugin";
import assert from "node:assert/strict";
import { createOpenCode2Plugin } from "#root/opencode2.js";
import { test } from "./test.ts";

type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0];
type RegisteredTool = Parameters<ToolEditor["add"]>[0];

const makeContext = (options?: {
  onTool?: (tool: RegisteredTool) => void;
  onSubscribe?: () => void;
  onToolDispose?: () => void;
  activeConnection?: () => Promise<unknown>;
  resolveConnection?: (connection: unknown) => Promise<unknown>;
  onRpcHandler?: (handler: (input: { retryCount?: number }) => Promise<unknown>) => void;
  onRpcDispose?: () => void;
  toolTransformError?: Error;
}) => {
  const context = {
    tool: {
      transform: async (transform: (editor: ToolEditor) => void) => {
        if (options?.toolTransformError) throw options.toolTransformError;
        transform({ add: options?.onTool ?? (() => undefined) } as ToolEditor);
        return {
          dispose: async () => options?.onToolDispose?.(),
        };
      },
    },
    event: {
      subscribe: () => {
        options?.onSubscribe?.();
        return {
          async *[Symbol.asyncIterator]() {
            yield* [];
          },
        };
      },
    },
    integration: {
      connection: {
        active: options?.activeConnection ?? (async () => undefined),
        resolve: options?.resolveConnection ?? (async () => undefined),
      },
    },
    rpc: {
      register: async (
        _definition: unknown,
        handlers: { usage: (input: { retryCount?: number }) => Promise<unknown> },
      ) => {
        options?.onRpcHandler?.(handlers.usage);
        return {
          dispose: async () => options?.onRpcDispose?.(),
          events: { emit: async () => undefined },
        };
      },
    },
  } as unknown as Plugin.Context;

  return { context };
};

test("OpenCode 2 plugin registers the official codex_usage tool result", async () => {
  let registeredTool: RegisteredTool | undefined;
  let toolDisposed = false;
  const plugin = createOpenCode2Plugin(async () => ({ status: "ok" }));
  const { context } = makeContext({
    onTool: (tool) => {
      registeredTool = tool;
    },
    onToolDispose: () => {
      toolDisposed = true;
    },
    activeConnection: async () => ({ id: "active" }),
    resolveConnection: async () => ({
      type: "oauth",
      access: "active-token",
      metadata: {},
    }),
  });

  const cleanup = await plugin.setup(context);

  assert.equal(plugin.id, "opencode-codex-usage");
  assert.equal(registeredTool?.name, "codex_usage");
  assert.deepEqual(registeredTool?.input, {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  });
  assert.deepEqual(await registeredTool?.execute({}, {} as never), {
    content: '{"status":"ok"}',
  });

  await cleanup?.();
  assert.equal(toolDisposed, true);
});

test("OpenCode 2 releases registrations once without subscribing to unused events", async () => {
  let subscriptions = 0;
  let toolsDisposed = 0;
  let rpcsDisposed = 0;
  const plugin = createOpenCode2Plugin(async () => ({ status: "ok" }));
  const { context } = makeContext({
    onSubscribe: () => subscriptions++,
    onToolDispose: () => toolsDisposed++,
    onRpcDispose: () => rpcsDisposed++,
  });

  const cleanup = await plugin.setup(context);
  await cleanup?.();
  await cleanup?.();
  assert.equal(subscriptions, 0);
  assert.equal(toolsDisposed, 1);
  assert.equal(rpcsDisposed, 1);
});

test("OpenCode 2 tool follows the active OAuth credential on every call", async () => {
  let registeredTool: RegisteredTool | undefined;
  let activeID = "first";
  const probes: unknown[] = [];
  const plugin = createOpenCode2Plugin(async (options) => {
    probes.push(options);
    return { status: "ok" };
  });
  const { context } = makeContext({
    onTool: (tool) => {
      registeredTool = tool;
    },
    activeConnection: async () => ({ id: activeID }),
    resolveConnection: async (connection) => ({
      type: "oauth",
      access: `token-${(connection as { id: string }).id}`,
      refresh: "unused",
      expires: Date.now() + 60_000,
      methodID: "chatgpt-browser",
      metadata: { accountID: `account-${(connection as { id: string }).id}` },
    }),
  });

  const cleanup = await plugin.setup(context);
  await registeredTool?.execute({}, {} as never);
  activeID = "second";
  await registeredTool?.execute({}, {} as never);

  assert.deepEqual(probes, [
    { credentials: { accessToken: "token-first", accountId: "account-first" } },
    { credentials: { accessToken: "token-second", accountId: "account-second" } },
  ]);
  await cleanup?.();
});

test("OpenCode 2 never falls back to legacy credentials without active OAuth", async () => {
  let registeredTool: RegisteredTool | undefined;
  let probes = 0;
  const plugin = createOpenCode2Plugin(async () => {
    probes++;
    return { status: "ok" };
  });
  const { context } = makeContext({
    onTool: (tool) => {
      registeredTool = tool;
    },
  });

  const cleanup = await plugin.setup(context);
  const result = await registeredTool?.execute({}, {} as never);

  assert.equal(probes, 0);
  const content = result?.content;
  assert.equal(typeof content, "string");
  if (typeof content !== "string") assert.fail("expected text tool content");
  assert.match(content, /active OpenAI OAuth connection/i);
  await cleanup?.();
});

test("OpenCode 2 setup rolls back acquired resources when registration fails", async () => {
  let rpcDisposed = false;
  const plugin = createOpenCode2Plugin(async () => ({ status: "ok" }));
  const { context } = makeContext({
    onRpcDispose: () => {
      rpcDisposed = true;
    },
    toolTransformError: new Error("tool registration failed"),
  });

  await assert.rejects(async () => await plugin.setup(context), /tool registration failed/);
  assert.equal(rpcDisposed, true);
});

test("OpenCode 2 RPC shares active-credential quota probing with the TUI", async () => {
  let rpcHandler: ((input: { retryCount?: number }) => Promise<unknown>) | undefined;
  let rpcDisposed = false;
  const plugin = createOpenCode2Plugin(async (options) => ({
    status: options?.credentials?.accessToken ?? "missing",
  }));
  const { context } = makeContext({
    activeConnection: async () => ({ id: "active" }),
    resolveConnection: async () => ({
      type: "oauth",
      access: "active-token",
      refresh: "unused",
      expires: Date.now() + 60_000,
      methodID: "chatgpt-browser",
      metadata: { accountID: "active-account" },
    }),
    onRpcHandler: (handler) => {
      rpcHandler = handler;
    },
    onRpcDispose: () => {
      rpcDisposed = true;
    },
  });

  const cleanup = await plugin.setup(context);
  assert.deepEqual(await rpcHandler?.({}), { status: "active-token" });
  await cleanup?.();
  assert.equal(rpcDisposed, true);
});

test("OpenCode 2 RPC forwards an explicit retry count to the quota probe", async () => {
  let rpcHandler: ((input: { retryCount?: number }) => Promise<unknown>) | undefined;
  const probes: unknown[] = [];
  const plugin = createOpenCode2Plugin(async (options) => {
    probes.push(options);
    return { status: "ok" };
  });
  const { context } = makeContext({
    activeConnection: async () => ({ id: "active" }),
    resolveConnection: async () => ({
      type: "oauth",
      access: "active-token",
      metadata: { accountID: "active-account" },
    }),
    onRpcHandler: (handler) => {
      rpcHandler = handler;
    },
  });
  const cleanup = await plugin.setup(context);
  try {
    await rpcHandler?.({ retryCount: 2 });
    assert.deepEqual(probes, [
      { retryCount: 2, credentials: { accessToken: "active-token", accountId: "active-account" } },
    ]);
  } finally {
    await cleanup?.();
  }
});
