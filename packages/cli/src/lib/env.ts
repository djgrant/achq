/** A secret from the environment. Values like op://vault/item/field are read from 1Password. */
export const need = (name: string, hint = "") => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in the environment.${hint ? ` ${hint}` : ""}`);
  if (!value.startsWith("op://")) return value;
  const read = Bun.spawnSync(["op", "read", value], { stderr: "pipe" });
  if (read.exitCode !== 0) throw new Error(`Couldn't read ${name} from 1Password: ${read.stderr.toString().trim()}`);
  return read.stdout.toString().trim();
};
