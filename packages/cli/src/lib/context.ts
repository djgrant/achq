import type { Context } from "@achq/core";
import { crypto } from "@achq/utils/crypto";

const SECRET_BYTES = 32;

/** What planning and applying the infra get from the CLI. Tests pass their own secrets and sleep; parts left undefined keep the CLI's. */
export const cliContext = (parts: Pick<Context, "env" | "log"> & Partial<Context>): Context => ({
  ...parts,
  newSecret: parts.newSecret ?? (() => crypto.randomHex(SECRET_BYTES)),
  sleep: parts.sleep ?? ((ms) => Bun.sleep(ms)),
});
