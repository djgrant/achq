// An empty variable counts as unset, as it does for a shell's `${X:-default}`.

export type Env = Record<string, string | undefined>;

export const optionalEnv = (env: Env, name: string): string | undefined => env[name] || undefined;

export const requireEnv = (env: Env, name: string, hint = ""): string => {
  const value = optionalEnv(env, name);
  if (value === undefined) throw new Error(`Missing ${name} in the environment.${hint ? ` ${hint}` : ""}`);
  return value;
};
