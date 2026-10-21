import {
  type CodeHostProvider,
  type ConfigTree,
  type DeployRecord,
  ENV,
  type RepoClient,
  type RepoManifest,
  type RouterRepoConfig,
  type Status,
} from "@achq/core";
import { containerSecret } from "@achq/core/secrets";
import { errors } from "@achq/utils/errors";
import { checkManifest, dockerfileOf } from "./checks.ts";
import { isSourceFile } from "./config/index.ts";
import { CONFIG_DIR, CONFIG_ENTRY } from "./constants.ts";
import type { DeployerContext } from "./context.ts";
import { type ImageRecord, type StoredRecord, wireRecord } from "./store.ts";

export type DeployOutcome = {
  repo: string;
  outcome: "deployed" | "unchanged" | "failed";
  error?: string;
  warnings?: string[];
  /** The manifest deployed (or, for a dry run, that would be). */
  manifest?: RepoManifest;
};

/** A failure that's reported as-is, with the warnings the checks found alongside it. */
class DeployFailure extends Error {
  constructor(
    message: string,
    readonly warnings: string[] = [],
  ) {
    super(message);
  }
}

/**
 * One deploy of one repo. It learns its client and tree as it goes, so that a
 * failure records as much as the deploy reached.
 */
type Run = {
  ctx: DeployerContext;
  hostId: string;
  repo: string;
  dryRun: boolean;
  previous: StoredRecord | undefined;
  client?: RepoClient;
  tree?: ConfigTree;
};

type Container = RepoManifest["containers"][number];
/** A tree with a `.achq/config.ts` to deploy. */
type ConfigTreeWithConfig = ConfigTree & { tree: string };
type EnsuredContainer = { name: string; url: string; image: ImageRecord };

const CONFIG_FILE = `${CONFIG_DIR}/${CONFIG_ENTRY}`;

const withWarnings = <T extends object>(value: T, warnings: string[] | undefined): T & { warnings?: string[] } =>
  warnings?.length ? { ...value, warnings } : value;

const ownerOf = (repo: string) => repo.split("/")[0]!;

const timestamp = (ctx: DeployerContext) => ctx.now().toISOString();

const checkRepoAllowed = ({ ctx, hostId, repo }: Run): CodeHostProvider => {
  const host = Object.hasOwn(ctx.codeHostProviders, hostId) ? ctx.codeHostProviders[hostId] : undefined;
  if (!host) throw new DeployFailure(`achq doesn't know the code host "${hostId}"`);
  if (!host.repoName.test(repo)) throw new DeployFailure(`"${repo}" isn't a repository name on ${hostId}`);
  // A stranger can install a public App. Their repo is recorded as failed but
  // never touched: no token is minted and nothing is read or evaluated.
  if (!ctx.owners.has(ownerOf(repo).toLowerCase())) throw new DeployFailure(`${ownerOf(repo)} isn't an owner this deployer serves`);
  return host;
};

const mintRepoClient = async ({ ctx, repo }: Run, host: CodeHostProvider): Promise<RepoClient> => {
  try {
    const policy = host.deployerPolicy(repo);
    const credentials = await ctx.router.mint({ repo, policies: [policy] });
    const credential = credentials.find((c) => c.provider === policy.provider);
    if (!credential) throw new Error(`the router minted no ${policy.provider} credential for ${repo}`);
    return host.repo(repo, credential);
  } catch (error) {
    throw new DeployFailure(`couldn't get a token for ${repo}: ${errors.message(error)}`);
  }
};

const isUnchanged = (previous: StoredRecord | undefined, hostId: string, tree: ConfigTree) =>
  previous?.state === "deployed" && previous.host === hostId && Boolean(tree.tree) && previous.deployed?.tree === tree.tree;

const hasConfig = (tree: ConfigTree): tree is ConfigTreeWithConfig => Boolean(tree.tree) && tree.blobs.has(CONFIG_ENTRY);

const downloadSources = (ctx: DeployerContext, client: RepoClient, tree: ConfigTree) =>
  client.download(tree, [...tree.blobs.keys()].filter(isSourceFile), ctx.fileLimits);

const evaluate = async (ctx: DeployerContext, files: Record<string, string>) => {
  try {
    return await ctx.evaluate(files);
  } catch (error) {
    throw new DeployFailure(`${CONFIG_FILE}: ${errors.message(error)}`);
  }
};

const policyProblems = async (ctx: DeployerContext, repo: string, manifest: RepoManifest) => {
  const policies = manifest.policies.map((p) => p.policy);
  return policies.length ? (await ctx.router.validate({ repo, policies })).problems : [];
};

/** Warnings don't stop a deploy. */
const evaluateAndCheck = async ({ ctx, repo }: Run, client: RepoClient, tree: ConfigTree) => {
  const manifest = await evaluate(ctx, await downloadSources(ctx, client, tree));
  const checked = checkManifest(manifest, { tree, sources: await ctx.router.sources() });
  const failures = [...checked.failures, ...(await policyProblems(ctx, repo, manifest))];
  if (failures.length) throw new DeployFailure(failures.join("; "), checked.warnings);
  return { manifest, warnings: checked.warnings };
};

const containerEnv = (ctx: DeployerContext, host: CodeHostProvider, repo: string, c: Container): Record<string, string> => ({
  ...ctx.env.containerEnv,
  [ENV.repo]: repo,
  [ENV.repoUrl]: host.cloneUrl(repo),
  [ENV.container]: c.name,
  [ENV.containerSecret]: containerSecret(ctx.env.key, repo, c.name),
  [ENV.routerUrl]: ctx.env.routerUrl,
  [ENV.ref]: ctx.env.ref,
  [ENV.privateEnv]: ctx.env.privateEnv.join(","),
});

const needsBuild = (before: ImageRecord | undefined, image: ImageRecord) => !before || before.dockerfile !== image.dockerfile || before.blob !== image.blob;

/**
 * Creates or updates the container's service, and builds it only when its
 * image changed. Containers load their config and credentials at runtime, so
 * nothing else needs a build: the router config update covers it.
 */
const ensureContainer = async ({ ctx, hostId, repo, previous }: Run, host: CodeHostProvider, tree: ConfigTree, c: Container): Promise<EnsuredContainer> => {
  // checkManifest has made sure the image is a Dockerfile in the tree.
  const { dockerfile, path } = dockerfileOf(c)!;
  const image: ImageRecord = { dockerfile, blob: tree.blobs.get(path)!.sha };
  const env = containerEnv(ctx, host, repo, c);
  const { url } = await ctx.containerProvider.ensure({ host: hostId, repo, name: c.name, dockerfile, branch: tree.branch, env });
  if (needsBuild(previous?.deployed?.images[c.name], image)) {
    ctx.log(`${repo}: building ${c.name} from ${dockerfile}`);
    await ctx.containerProvider.deploy(repo, c.name);
  }
  return { name: c.name, url, image };
};

/** Each container in turn: builds are slow, and a provider may not take several at once. */
const ensureContainers = async (run: Run, host: CodeHostProvider, tree: ConfigTree, manifest: RepoManifest) => {
  const ensured: EnsuredContainer[] = [];
  for (const c of manifest.containers) ensured.push(await ensureContainer(run, host, tree, c));
  return ensured;
};

/** parseManifest has made sure each is there. */
const policiesOf = (manifest: RepoManifest, c: Container) => c.policies.map((name) => manifest.policies.find((p) => p.name === name)!.policy);

const routerConfigFor = ({ hostId, repo }: Run, tree: ConfigTree, manifest: RepoManifest, ensured: EnsuredContainer[]): RouterRepoConfig => ({
  host: hostId,
  repo,
  commit: tree.commit,
  containers: manifest.containers.map((c, i) => ({ name: c.name, url: ensured[i]!.url, policies: policiesOf(manifest, c) })),
  workspaces: manifest.workspaces,
  triggers: manifest.triggers.map((t) => ({ name: t.name, event: t.event })),
});

/** Where each container is, for `achq container ssh` and `achq container resume`. */
const locateContainers = async (ctx: DeployerContext, repo: string, manifest: RepoManifest) => {
  const located: NonNullable<DeployRecord["containers"]> = [];
  for (const c of manifest.containers) located.push({ name: c.name, location: await ctx.containerProvider.locate(repo, c.name) });
  return located;
};

const deployedRecord = (
  { ctx, hostId, repo }: Run,
  tree: ConfigTreeWithConfig,
  { manifest, warnings }: { manifest: RepoManifest; warnings: string[] },
  ensured: EnsuredContainer[],
  located: NonNullable<DeployRecord["containers"]>,
): StoredRecord => {
  const images = Object.fromEntries(ensured.map((e) => [e.name, e.image]));
  const record: StoredRecord = { host: hostId, repo, state: "deployed", at: timestamp(ctx), commit: tree.commit, containers: located };
  return { ...withWarnings(record, warnings), deployed: { tree: tree.tree, manifest, images } };
};

/** A failed deploy keeps the last one that succeeded, so the next can tell what changed. */
const failedRecord = ({ ctx, hostId, repo, tree, previous }: Run, error: string, warnings: string[]): StoredRecord => {
  const record: StoredRecord = { host: hostId, repo, state: "failed", at: timestamp(ctx), error, ...(tree && { commit: tree.commit }) };
  return { ...withWarnings(record, warnings), ...(previous?.deployed && { deployed: previous.deployed }) };
};

/** Writes the record to the repo's ACHQ_STATUS. A failure to is only logged: the deploy itself is done. */
const writeStatus = async (ctx: DeployerContext, client: RepoClient, record: StoredRecord) => {
  try {
    await client.writeStatus({ ...wireRecord(record), router: ctx.env.routerPublicUrl } satisfies Status);
  } catch (error) {
    ctx.log(`${record.repo}: couldn't write ACHQ_STATUS: ${errors.message(error)}`);
  }
};

const saveRecord = async (run: Run, record: StoredRecord) => {
  await run.ctx.store.put(record);
  if (run.client) await writeStatus(run.ctx, run.client, record);
};

const reportFailure = async (run: Run, failure: unknown): Promise<DeployOutcome> => {
  const error = errors.message(failure);
  const warnings = failure instanceof DeployFailure ? failure.warnings : [];
  run.ctx.log(`${run.repo}: deploy failed: ${error}`);
  if (!run.dryRun) await saveRecord(run, failedRecord(run, error, warnings));
  return withWarnings({ repo: run.repo, outcome: "failed", error }, warnings);
};

const deployRun = async (run: Run): Promise<DeployOutcome> => {
  const { ctx, repo, previous } = run;
  const host = checkRepoAllowed(run);
  const client = await mintRepoClient(run, host);
  run.client = client;
  const tree = await client.config();
  run.tree = tree;

  if (isUnchanged(previous, run.hostId, tree)) {
    ctx.log(`${repo}: ${CONFIG_DIR}/ unchanged at ${tree.commit}`);
    return withWarnings({ repo, outcome: "unchanged", manifest: previous?.deployed?.manifest }, previous?.warnings);
  }
  if (!hasConfig(tree)) throw new DeployFailure(`there's no ${CONFIG_FILE} on ${tree.branch}`);
  const checked = await evaluateAndCheck(run, client, tree);
  const { manifest, warnings } = checked;
  if (run.dryRun) return withWarnings({ repo, outcome: "deployed", manifest }, warnings);

  const ensured = await ensureContainers(run, host, tree, manifest);
  // Containers removed from the config are left alone, asleep; only `sync({ prune })` deletes them.
  await ctx.router.putRepo(routerConfigFor(run, tree, manifest, ensured));
  const located = await locateContainers(ctx, repo, manifest);
  await saveRecord(run, deployedRecord(run, tree, checked, ensured, located));
  ctx.log(`${repo}: deployed ${tree.commit}`);
  return withWarnings({ repo, outcome: "deployed", manifest }, warnings);
};

/** Run one per repo at a time. */
export const deploy = async (ctx: DeployerContext, hostId: string, repo: string, dryRun: boolean): Promise<DeployOutcome> => {
  const run: Run = { ctx, hostId, repo, dryRun, previous: await ctx.store.get(repo) };
  try {
    return await deployRun(run);
  } catch (error) {
    return reportFailure(run, error);
  }
};
