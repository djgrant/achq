/** `env[name]`, or an error saying it's missing. */
export const need = (env: Record<string, string | undefined>, name: string, hint = "") => {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name} in the environment.${hint ? ` ${hint}` : ""}`);
  return value;
};
