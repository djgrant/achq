import { randomBytes } from "node:crypto";
import type { Context } from "@achq/core";

/** What planning and applying the infra get from the CLI. Tests pass their own secrets and sleep. */
export const cliContext = (parts: Pick<Context, "env" | "log"> & Partial<Context>): Context => ({
  newSecret: () => randomBytes(32).toString("hex"),
  sleep: (ms) => Bun.sleep(ms),
  ...parts,
});
