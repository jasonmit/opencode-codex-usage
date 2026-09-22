import { Rpc } from "@opencode/plugin";

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
      output: {
        type: "object",
        properties: {
          status: { type: "string" },
        },
        required: ["status"],
        additionalProperties: true,
      },
    },
  },
  events: {},
});
