// Reading settings from an environment. An empty variable counts as unset, as
// it does for a shell's `${X:-default}`.

export type Env = Record<string, string | undefined>;

/** `env[name]`, or undefined when it's unset or empty. */
export const optionalEnv = (env: Env, name: string): string | undefined => env[name] || undefined;

/** `env[name]`, or an error saying it's missing, followed by `hint` on how to set it. */
export const requireEnv = (env: Env, name: string, hint = ""): string => {
  const value = optionalEnv(env, name);
  if (value === undefined) throw new Error(`Missing ${name} in the environment.${hint ? ` ${hint}` : ""}`);
  return value;
};
