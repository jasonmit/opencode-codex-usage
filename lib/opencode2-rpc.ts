import { Rpc } from "@opencode/plugin";
import { z } from "zod";
import { ProbeSnapshotSchema } from "./codex-usage-probe.js";

export const UsageRequestSchema = z
  .object({
    retryCount: z.number().int().min(0).max(2).optional(),
  })
  .strict();

export type UsageRequest = z.infer<typeof UsageRequestSchema>;

export const CODEX_USAGE_RPC = Rpc.define({
  id: "opencode-codex-usage",
  methods: {
    usage: {
      input: UsageRequestSchema,
      output: ProbeSnapshotSchema,
    },
  },
  events: {},
});
