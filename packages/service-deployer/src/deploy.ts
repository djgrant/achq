import { BrowserActionNeeded, CONFIG_DIR, CONFIG_ENTRY, type DeployRecord, ENV, type RepoClient, type RepoManifest, repoName, type Status } from "@achq/core";
import { containerSecret } from "@achq/core/secrets";
import { crypto } from "@achq/utils/crypto";
import { errors } from "@achq/utils/errors";
import { json } from "@achq/utils/json";
import { checkManifest, dockerfileOf } from "./checks.ts";
import { isSourceFile } from "./config/evaluate.ts";
import type { DeployerContext } from "./deployer.ts";
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

const CONFIG_FILE = `${CONFIG_DIR}/${CONFIG_ENTRY}`;

const withWarnings = <T extends object>(value: T, warnings: string[] | undefined): T & { warnings?: string[] } =>
  warnings?.length ? { ...value, warnings } : value;

/** The repo as the deployer's own credential, which the router mints, reaches it. */
export const repoClient = async (ctx: DeployerContext, repo: string) => {
  const policy = ctx.codeHost.deployerPolicy(repo);
  const credential = (await ctx.router.mint({ repo, policies: [policy] })).find((c) => c.provider === policy.provider);
  if (!credential) throw new Error(`the router minted no ${policy.provider} credential for ${repo}`);
  return ctx.codeHost.repo(repo, credential);
};

/** One deploy of one repo. Run one per repo at a time. */
export const deploy = async (ctx: DeployerContext, repo: string, dryRun: boolean): Promise<DeployOutcome> => {
  const previous = await ctx.store.get(repo);
  // What the deploy has reached, so a failure records as much: the client that writes ACHQ_STATUS, and the commit it read.
  let client: RepoClient | undefined;
  let commit: string | undefined;

  /** Keeps the record, and writes it to the repo's ACHQ_STATUS once there's a client. A failure to write is only logged: the deploy itself is done. */
  const save = async (record: StoredRecord) => {
    await ctx.store.put(record);
    if (!client) return;
    try {
      await client.writeStatus({ ...wireRecord(record), router: ctx.env.routerPublicUrl } satisfies Status);
    } catch (error) {
      ctx.log(`${repo}: couldn't write ACHQ_STATUS: ${errors.message(error)}`);
    }
  };

  try {
    if (!ctx.codeHost.repoName.test(repo)) throw new DeployFailure(`"${repo}" isn't a repository name`);
    // A stranger can install a public App. Their repo is recorded as failed but
    // never touched: no token is minted and nothing is read or evaluated.
    const { owner } = repoName.split(repo);
    if (!ctx.owners.has(owner.toLowerCase())) throw new DeployFailure(`${owner} isn't an owner this deployer serves`);

    try {
      client = await repoClient(ctx, repo);
    } catch (error) {
      throw new DeployFailure(`couldn't get a token for ${repo}: ${errors.message(error)}`);
    }
    const tree = await client.config();
    commit = tree.commit;

    // What the deployer gives every container, e.g. the agents' tokens. A change to it redeploys every repo; it's hashed, as it holds secrets.
    const shared = { ...ctx.env.containerEnv, [ENV.routerUrl]: ctx.env.routerUrl, [ENV.ref]: ctx.env.ref };
    const given = crypto.sha256Hex(json.stableStringify(shared));
    if (previous?.state === "deployed" && tree.tree && previous.deployed?.tree === tree.tree && previous.deployed.given === given) {
      ctx.log(`${repo}: ${CONFIG_DIR}/ unchanged at ${tree.commit}`);
      return withWarnings({ repo, outcome: "unchanged", manifest: previous.deployed.manifest }, previous.warnings);
    }
    if (!tree.tree || !tree.blobs.has(CONFIG_ENTRY)) throw new DeployFailure(`there's no ${CONFIG_FILE} on ${tree.branch}`);
    const files = await client.download(tree, [...tree.blobs.keys()].filter(isSourceFile), ctx.fileLimits);
    const manifest = await ctx.evaluate(files).catch((error): never => {
      throw new DeployFailure(`${CONFIG_FILE}: ${errors.message(error)}`);
    });
    const checked = checkManifest(manifest, { tree, sources: await ctx.router.sources() });
    const policies = manifest.policies.map((p) => p.policy);
    const problems = policies.length ? (await ctx.router.validate({ repo, policies })).problems : [];
    // Warnings don't stop a deploy.
    if (checked.failures.length || problems.length) throw new DeployFailure([...checked.failures, ...problems].join("; "), checked.warnings);
    if (dryRun) return withWarnings({ repo, outcome: "deployed", manifest }, checked.warnings);

    // Each container in turn: builds are slow, and a provider may not take several at once.
    const urls: Record<string, string> = {};
    const images: Record<string, ImageRecord> = {};
    for (const c of manifest.containers) {
      // checkManifest has made sure the image is a Dockerfile in the tree.
      const { dockerfile, path } = dockerfileOf(c)!;
      const image = { dockerfile, blob: tree.blobs.get(path)!.sha };
      const env = {
        ...shared,
        [ENV.repo]: repo,
        [ENV.repoUrl]: ctx.codeHost.cloneUrl(repo),
        [ENV.container]: c.name,
        [ENV.containerSecret]: containerSecret(ctx.env.key, repo, c.name),
      };
      // Containers load their config and credentials at runtime, so only a new container or a changed image needs a build: the router config covers the rest.
      const before = previous?.deployed?.images[c.name];
      const build = !before || before.dockerfile !== image.dockerfile || before.blob !== image.blob;
      if (build) ctx.log(`${repo}: building ${c.name} from ${dockerfile}`);
      urls[c.name] = (await ctx.containerProvider.ensure({ repo, identity: tree.identity, name: c.name, dockerfile, branch: tree.branch, env }, { build })).url;
      images[c.name] = image;
    }

    // Containers removed from the config are left alone, asleep; only `sync({ prune })` deletes them.
    await ctx.router.putRepo({
      repo,
      commit: tree.commit,
      // validateManifest has made sure each of a container's policies is there.
      containers: manifest.containers.map((c) => ({ name: c.name, url: urls[c.name]!, policies: c.policies.map((name) => manifest.policies.find((p) => p.name === name)!.policy) })),
      workspaces: manifest.workspaces,
      triggers: manifest.triggers.map((t) => ({ name: t.name, event: t.event })),
    });

    // Where each container is, for `achq container ssh` and `achq container resume`.
    const containers: NonNullable<DeployRecord["containers"]> = [];
    for (const c of manifest.containers) containers.push({ name: c.name, location: await ctx.containerProvider.locate(repo, c.name) });

    const record: StoredRecord = { repo, state: "deployed", at: ctx.now().toISOString(), commit: tree.commit, containers };
    await save({ ...withWarnings(record, checked.warnings), deployed: { tree: tree.tree, manifest, images, given } });
    ctx.log(`${repo}: deployed ${tree.commit}`);
    return withWarnings({ repo, outcome: "deployed", manifest }, checked.warnings);
  } catch (failure) {
    const error = errors.message(failure);
    const warnings = failure instanceof DeployFailure ? failure.warnings : [];
    ctx.log(`${repo}: deploy failed: ${error}`);
    if (!dryRun) {
      // A failed deploy keeps the last one that succeeded, so the next can tell what changed.
      // What only a person can fix, e.g. a vendor's App missing from the repo, goes with it, for `achq repo install` to open.
      const action = failure instanceof BrowserActionNeeded ? failure.action : undefined;
      const record: StoredRecord = { repo, state: "failed", at: ctx.now().toISOString(), error, ...(commit && { commit }), ...(action && { action }) };
      await save({ ...withWarnings(record, warnings), ...(previous?.deployed && { deployed: previous.deployed }) });
    }
    return withWarnings({ repo, outcome: "failed", error }, warnings);
  }
};
