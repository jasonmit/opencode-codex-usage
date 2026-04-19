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

test("probeQuota does not fallback to a different model when model is unsupported", async () => {
  const seenModels: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    const model = body.model ?? "";
    seenModels.push(model);

    if (model === "gpt-5.3-codex") {
      return new Response(
        JSON.stringify({
          detail:
            "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    return successResponse();
  };

  const snapshot = await probeQuota({
    retryCount: 0,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.deepEqual(seenModels, ["gpt-5.3-codex"]);
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.statusCode, 400);
  assert.match(snapshot.error ?? "", /model is not supported/i);
});

test("probeQuota extracts JSON detail for probe errors", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response(
      JSON.stringify({ detail: "The selected model is not available" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  };

  const snapshot = await probeQuota({
    retryCount: 0,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.statusCode, 400);
  assert.equal(snapshot.error, "The selected model is not available");
});

test("probeQuota honors OPENCODE_CODEX_QUOTA_MODEL env override", async () => {
  const seenModels: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    seenModels.push(body.model ?? "");
    return successResponse();
  };

  const snapshot = await probeQuota({
    fetchImpl,
    credentials: { accessToken: "token" },
    env: { OPENCODE_CODEX_QUOTA_MODEL: "gpt-5.3-codex" },
  });

  assert.deepEqual(seenModels, ["gpt-5.3-codex"]);
  assert.equal(snapshot.statusCode, 200);
});

test("probeQuota model option overrides env model", async () => {
  const seenModels: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    seenModels.push(body.model ?? "");
    return successResponse();
  };

  const snapshot = await probeQuota({
    fetchImpl,
    credentials: { accessToken: "token" },
    model: "gpt-5.1-codex",
    env: { OPENCODE_CODEX_QUOTA_MODEL: "gpt-5.3-codex" },
  });

  assert.deepEqual(seenModels, ["gpt-5.1-codex"]);
  assert.equal(snapshot.statusCode, 200);
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
