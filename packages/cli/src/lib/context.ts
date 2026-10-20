import type { Context } from "@achq/core";
import { randomHex } from "@achq/utils/crypto";

/** How many random bytes a GENERATED secret has. */
const SECRET_BYTES = 32;

/** What planning and applying the infra get from the CLI. Tests pass their own secrets and sleep; parts left undefined keep the CLI's. */
export const cliContext = (parts: Pick<Context, "env" | "log"> & Partial<Context>): Context => ({
  ...parts,
  newSecret: parts.newSecret ?? (() => randomHex(SECRET_BYTES)),
  sleep: parts.sleep ?? ((ms) => Bun.sleep(ms)),
});
