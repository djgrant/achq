// Outside core's index, which the config sandbox loads without Bun or node:crypto.
import { crypto } from "@achq/utils/crypto";
import type { Context } from "../resources/resource.ts";

const SECRET_BYTES = 32;

/** A Context outside the sandbox: parts left undefined make random secrets, sleep for real and log nothing. */
export const context = (parts: Pick<Context, "env"> & Partial<Context>) => ({
  ...parts,
  log: parts.log ?? (() => {}),
  newSecret: parts.newSecret ?? (() => crypto.randomHex(SECRET_BYTES)),
  sleep: parts.sleep ?? ((ms) => Bun.sleep(ms)),
}) satisfies Context;
