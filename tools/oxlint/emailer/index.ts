import { eslintCompatPlugin } from "@oxlint/plugins";

import { flakySkipsRule } from "./flaky-skips.ts";

/** emailer's own lint rules. */
export default eslintCompatPlugin({
  meta: { name: "emailer" },
  rules: { "flaky-skips": flakySkipsRule },
});
