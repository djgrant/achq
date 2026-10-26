/** Where npm packages are looked up: npm's registry, unless NPM_CONFIG_REGISTRY names another. */
const registry = () => (process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org").replace(/\/+$/, "");

/** What `achq infra up` reads of a published version: what it needs installed beside it. */
export type Published = { peerDependencies?: Record<string, string> };

/** `pkg` at `version` as npm publishes it, or undefined if it isn't there. */
export type Npm = (pkg: string, version: string) => Promise<Published | undefined>;

const NOT_FOUND = 404;

export const npm: Npm = async (pkg, version) => {
  // A scoped name's slash is encoded; its `@` isn't.
  const res = await fetch(`${registry()}/${pkg.replace("/", "%2F")}/${encodeURIComponent(version)}`, { headers: { accept: "application/json" } });
  if (res.status === NOT_FOUND) return undefined;
  if (!res.ok) throw new Error(`npm answered ${res.status} for ${pkg}@${version}`);
  return (await res.json()) as Published;
};
