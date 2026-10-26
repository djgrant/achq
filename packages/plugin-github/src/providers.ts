import type { Providers } from "@achq/core";
import { githubChannelProvider } from "./channel/index.ts";
import { githubCodeHostProvider } from "./code-host/index.ts";
import { githubPolicyProvider } from "./policy/index.ts";

/** What the router, deployer and containers load from this package. */
export const providers: Providers = {
  channels: [githubChannelProvider],
  policies: [githubPolicyProvider],
  codeHosts: [githubCodeHostProvider],
};
