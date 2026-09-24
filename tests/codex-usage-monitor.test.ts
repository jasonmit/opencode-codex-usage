import assert from "node:assert/strict";
import { createQuotaMonitor } from "#lib/codex-usage-monitor.js";
import type { ToastBody } from "#lib/quota-toast.js";
import { type ProbeSnapshot } from "#lib/codex-usage-probe.js";
import { test } from "./test.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

const setup = (snapshots: ProbeSnapshot[] = []) => {
  const timers = new Map<number | ReturnType<typeof setInterval>, () => void>();
  const cleared: Array<number | ReturnType<typeof setInterval>> = [];
  const toasts: ToastBody[] = [];
  const errors: string[] = [];
  let nextTimer = 1;
  let revision = 0;
  let probes = 0;

  const monitor = createQuotaMonitor({
    probe: async () => snapshots[probes++] ?? { status: "ok" },
    notify: (toast) => {
      toasts.push(toast);
    },
    logError: (message) => {
      errors.push(message);
    },
    pollMs: 100,
    threshold: "warn",
    durationMs: 5000,
    signalPath: "/tmp/codex.signal",
    signalWatchMs: 50,
    readSignalRevision: () => revision,
    setInterval: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);

      return id;
    },
    clearInterval: (id) => {
      cleared.push(id);
      timers.delete(id);
    },
  });

  return {
    monitor,
    timers,
    cleared,
    toasts,
    errors,
    probes: () => probes,
    setRevision: (value: number) => {
      revision = value;
    },
  };
};

test("monitor starts polling immediately and clears every timer", async () => {
  const state = setup();
  state.monitor.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.probes(), 1);
  assert.equal(state.timers.size, 2);

  state.timers.get(1)?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.probes(), 2);

  state.monitor.stop();
  assert.equal(state.timers.size, 0);
  assert.equal(state.cleared.length, 2);
});

test("monitor only notifies worsening background threshold transitions", async () => {
  const state = setup([
    { status: "ok" },
    { status: "warn" },
    { status: "warn" },
    { status: "critical" },
  ]);

  await state.monitor.refresh();
  await state.monitor.refresh();
  await state.monitor.refresh();
  await state.monitor.refresh();
  assert.deepEqual(
    state.toasts.map((toast) => toast.variant),
    ["warning", "error"],
  );
});

test("timer restart can preserve background transition state", async () => {
  const state = setup([{ status: "warn" }, { status: "warn" }]);
  await state.monitor.refresh();
  state.monitor.stop({ resetStatus: false });
  await state.monitor.refresh();
  assert.equal(state.toasts.length, 1);
});

test("forced refresh bypasses threshold and reports requested failures", async () => {
  const state = setup([{ status: "ok" }, { status: "error", error: "offline" }]);
  await state.monitor.refresh({ force: true });
  await state.monitor.refresh({ force: true, showFailure: true });
  assert.equal(state.toasts.length, 2);
  assert.equal(state.toasts[1]?.variant, "error");
  assert.deepEqual(state.errors, ["quota probe failed"]);
});

test("requested auth failures retain their original detail", async () => {
  const state = setup([
    {
      status: "error",
      statusCode: "auth",
      error: "missing access token",
    },
  ]);

  await state.monitor.refresh({ force: true, showFailure: true });
  assert.equal(state.toasts[0]?.variant, "error");
  assert.match(state.toasts[0]?.message ?? "", /missing access token/);
});

test("forced refresh arriving during a probe runs once afterward", async () => {
  const first = deferred<{ status: string }>();
  let probes = 0;
  const toasts: ToastBody[] = [];

  const monitor = createQuotaMonitor({
    probe: () => {
      probes++;

      return probes === 1 ? first.promise : Promise.resolve({ status: "ok" });
    },
    notify: (toast) => {
      toasts.push(toast);
    },
    logError: () => undefined,
    pollMs: 100,
    threshold: "never",
    durationMs: 5000,
    signalPath: "/tmp/codex.signal",
  });

  const running = monitor.refresh();
  const queued = monitor.refresh({ force: true });
  void monitor.refresh({ force: true });
  first.resolve({ status: "ok" });
  await Promise.all([running, queued]);
  assert.equal(probes, 2);
  assert.equal(toasts.length, 1);
});

test("stop invalidates in-flight probes and queued refreshes", async () => {
  const first = deferred<{ status: string }>();
  let probes = 0;
  const toasts: ToastBody[] = [];

  const monitor = createQuotaMonitor({
    probe: () => {
      probes++;

      return first.promise;
    },
    notify: (toast) => {
      toasts.push(toast);
    },
    logError: () => undefined,
    pollMs: 100,
    threshold: "always",
    durationMs: 5000,
    signalPath: "/tmp/codex.signal",
  });

  const running = monitor.refresh({ force: true });
  void monitor.refresh({ force: true });
  monitor.stop();
  first.resolve({ status: "critical" });
  await running;
  assert.equal(probes, 1);
  assert.equal(toasts.length, 0);
});

test("restart during an in-flight probe queues a fresh startup probe", async () => {
  const first = deferred<{ status: string }>();
  let probes = 0;

  const monitor = createQuotaMonitor({
    probe: () => {
      probes++;

      return probes === 1 ? first.promise : Promise.resolve({ status: "ok" });
    },
    notify: () => undefined,
    logError: () => undefined,
    pollMs: 100,
    threshold: "never",
    durationMs: 5000,
    signalPath: "/tmp/codex.signal",
  });

  monitor.start();
  monitor.stop({ resetStatus: false });
  monitor.start();
  first.resolve({ status: "warn" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(probes, 2);
  monitor.stop();
});

test("signal revision changes force a refresh", async () => {
  const state = setup();
  state.monitor.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  state.setRevision(2);
  state.timers.get(2)?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.probes(), 2);
  assert.equal(state.toasts.length, 1);
  state.monitor.stop();
});
