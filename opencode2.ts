import { Plugin } from "@opencode/plugin";
import { probeQuota, type ProbeQuotaOptions, type ProbeSnapshot } from "./lib/codex-usage-probe.js";
import { CODEX_USAGE_RPC, type UsageRequest } from "./lib/opencode2-rpc.js";

const CODEX_USAGE_DESCRIPTION =
  "Get current Codex quota usage and reset times for the connected ChatGPT account. Use whenever the user asks about Codex usage, ChatGPT usage, remaining quota, limits, or reset times. Does not report OpenAI API billing or general ChatGPT message limits.";

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

const NO_ACTIVE_OPENAI_CONNECTION: ProbeSnapshot = {
  status: "error",
  statusCode: "auth",
  error:
    "No active OpenAI OAuth connection is available in OpenCode 2. Connect or reauthenticate your ChatGPT account.",
};

type QuotaProbe = (options?: ProbeQuotaOptions) => Promise<ProbeSnapshot>;

const activeCredentials = async (
  ctx: Plugin.Context,
): Promise<ProbeQuotaOptions["credentials"] | undefined> => {
  const connection = await ctx.integration.connection.active("openai");

  if (!connection) return undefined;

  const credential = await ctx.integration.connection.resolve(connection);

  if (credential?.type !== "oauth") return undefined;

  const accountId = credential.metadata?.accountID ?? credential.metadata?.accountId;

  return {
    accessToken: credential.access,
    accountId: typeof accountId === "string" ? accountId : undefined,
  };
};

export const createOpenCode2Plugin = (probe: QuotaProbe = probeQuota) =>
  Plugin.define({
    id: "opencode-codex-usage",
    async setup(ctx) {
      const disposers: Array<() => Promise<void>> = [];

      const readQuota = async (input: UsageRequest) => {
        const credentials = await activeCredentials(ctx);

        if (!credentials) return NO_ACTIVE_OPENAI_CONNECTION;

        return probe({ ...input, credentials });
      };

      try {
        const rpcRegistration = await ctx.rpc.register(CODEX_USAGE_RPC, {
          usage: readQuota,
          pollingEligible: async ({ sessionID }) => {
            const session = await ctx.session.get({ sessionID });

            const model =
              session.model ?? (await ctx.model.default({ location: session.location })).data;

            if (model?.providerID !== "openai") return false;

            return (await activeCredentials(ctx)) !== undefined;
          },
        });

        disposers.push(() => rpcRegistration.dispose());

        const toolRegistration = await ctx.tool.transform((editor) =>
          editor.add({
            name: "codex_usage",
            description: CODEX_USAGE_DESCRIPTION,
            input: EMPTY_OBJECT_SCHEMA,
            execute: async () => ({ content: JSON.stringify(await readQuota({})) }),
          }),
        );

        disposers.push(() => toolRegistration.dispose());
      } catch (error) {
        await Promise.allSettled([...disposers].reverse().map((dispose) => dispose()));
        throw error;
      }

      let disposed = false;

      return async () => {
        if (disposed) return;
        disposed = true;
        await Promise.all([...disposers].reverse().map((dispose) => dispose()));
      };
    },
  });

export default createOpenCode2Plugin();
