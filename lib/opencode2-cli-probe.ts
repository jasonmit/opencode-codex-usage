import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { ProbeSnapshotSchema, type ProbeSnapshot } from "./codex-usage-probe.js";

const execute = promisify(execFile);
const responseSchema = z.object({ output: ProbeSnapshotSchema });

export const probeOpenCode2Quota = async (retryCount?: number): Promise<ProbeSnapshot> => {
  // Let the host CLI select and authenticate its local or remote server.
  const { stdout } = await execute(
    "opencode",
    [
      "api",
      "post",
      "/api/rpc/opencode-codex-usage/usage",
      "--data",
      JSON.stringify({ input: { retryCount } }),
    ],
    { encoding: "utf8", timeout: 180_000 },
  );
  try {
    const response: unknown = JSON.parse(stdout);
    return responseSchema.parse(response).output;
  } catch (error) {
    throw new Error("Invalid quota response from OpenCode 2", { cause: error });
  }
};
