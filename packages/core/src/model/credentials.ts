import type { Json } from "@achq/utils/json";

export type Credential = {
  value: string;
  /** ISO time. */
  expiresAt: string;
  /** What it covers, for the policy provider or channel that minted it. e.g. `{ source, repos, permissions }`. */
  scope: { [key: string]: Json };
};

/** For the container's runner: minted by the channel it names. */
export type ChannelCredential = Credential & { channel: string };

/** For agents: minted by the policy provider it names. */
export type PolicyCredential = Credential & { provider: string };
