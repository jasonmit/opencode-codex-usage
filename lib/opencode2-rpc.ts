import { Rpc } from "@opencode/plugin";
import { ProbeSnapshotSchema } from "./codex-usage-probe.js";

export const CODEX_USAGE_RPC = Rpc.define({
  id: "opencode-codex-usage",
  methods: {
    usage: {
      input: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      output: ProbeSnapshotSchema,
    },
  },
  events: {},
});
