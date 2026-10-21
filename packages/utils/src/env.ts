/** Variables by name, as `process.env` has them. */
export type Vars = Record<string, string | undefined>;

/** Settings read from variables. An empty one is as good as unset. */
export class Env {
  constructor(readonly vars: Vars) {}

  optional(name: string) {
    return this.vars[name] || undefined;
  }

  /** Throws naming what's missing, and `hint` on how to set it. */
  require(name: string, hint = "") {
    const value = this.optional(name);
    if (value === undefined) throw new Error(`Missing ${name} in the environment.${hint ? ` ${hint}` : ""}`);
    return value;
  }
}
