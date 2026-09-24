import { eslintCompatPlugin } from "@oxlint/plugins";
import { requireReadableSpacingRule } from "./rules/require-readable-spacing.ts";

export default eslintCompatPlugin({
  meta: { name: "readable-spacing" },
  rules: { "require-readable-spacing": requireReadableSpacingRule },
});
