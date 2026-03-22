import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableProbeFailure, probeQuota } from "../lib/codex-usage-probe.js";

const successResponse = (): Response => {
  return new Response("data: [DONE]\n", {
    status: 200,
    headers: {
      "x-codex-primary-used-percent": "0.81",
      "x-codex-secondary-used-percent": "9",
      "x-codex-primary-reset-after-seconds": "3600",
      "x-codex-secondary-reset-after-seconds": "7200",
      "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-plan-type": "plus",
      "x-codex-bengalfox-limit-name": "default",
    },
  });
};

test("probeQuota retries once on network failure", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("network down");
    }
    return successResponse();
  };

  const snapshot = await probeQuota({
    retryCount: 1,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.equal(calls, 2);
  assert.equal(snapshot.status, "warn");
  assert.deepEqual(snapshot.used, { primary: 81, secondary: 9 });
});

test("probeQuota does not retry auth/http 401 failures", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("unauthorized", { status: 401 });
  };

  const snapshot = await probeQuota({
    retryCount: 2,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.equal(calls, 1);
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.statusCode, 401);
});

test("probeQuota does not retry when retry count is disabled", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    throw new Error("network down");
  };

  const snapshot = await probeQuota({
    retryCount: 0,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.equal(calls, 1);
  assert.equal(snapshot.statusCode, "network");
});

test("isRetryableProbeFailure follows transient-only policy", () => {
  assert.equal(isRetryableProbeFailure({ status: "error", statusCode: "network" }), true);
  assert.equal(isRetryableProbeFailure({ status: "error", statusCode: "timeout" }), true);
  assert.equal(isRetryableProbeFailure({ status: "error", statusCode: 503 }), true);
  assert.equal(isRetryableProbeFailure({ status: "error", statusCode: 429 }), true);
  assert.equal(isRetryableProbeFailure({ status: "error", statusCode: 401 }), false);
  assert.equal(isRetryableProbeFailure({ status: "warn", statusCode: 503 }), false);
});
