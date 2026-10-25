import * as fs from "node:fs";
import * as path from "node:path";
import type { PolicyProvider } from "@achq/core";

/** Writes each token to `dir/token` (mode 600) and points agents at it. */
export const testPolicyProvider = (): PolicyProvider => ({
  id: "test-policy-provider",
  validate: async () => [],
  mint: async () => [],
  async install(credentials, dir) {
    const file = path.join(dir, "token");
    fs.writeFileSync(file, credentials[0]!.value, { mode: 0o600 });
    return { env: { TEST_TOKEN_FILE: file } };
  },
});
