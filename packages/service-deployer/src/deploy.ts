// See "Subscribing", "Config changes", "Checks" and "Deploy results" in
// docs/achq-design.md.
import { CONTAINER_PORT, type ConfigTree, ENV, type DeployRecord, type RepoClient, type RepoPlan, type RouterRepoConfig, type Status } from "@achq/core";
import { containerSecret } from "@achq/core/secrets";
import { checkPlan } from "./checks.ts";
import { isSourceFile, normaliseRepoPath } from "./config/index.ts";
import type { DeployerContext } from "./context.ts";
import { type ImageRecord, type StoredRecord, wireRecord } from "./store.ts";

export type DeployOutcome = {
  repo: string;
  outcome: "deployed" | "unchanged" | "failed";
  error?: string;
  warnings?: string[];
  /** The plan deployed (or, for a dry run, that would be). */
  plan?: RepoPlan;
};

/** A failure that's reported as-is. */
class DeployFailure extends Error {}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const writeStatus = async (ctx: DeployerContext, client: RepoClient | undefined, record: StoredRecord) => {
  if (!client) return;
  try {
    await client.writeStatus({ ...wireRecord(record), ...(ctx.env.routerPublicUrl && { router: ctx.env.routerPublicUrl }) } satisfies Status);
  } catch (error) {
    ctx.log(`${record.repo}: couldn't write ACHQ_STATUS: ${message(error)}`);
  }
};

/** Deploys `repo`'s `.achq/` on `hostId`, as `source` (e.g. the App) sees it. Run one per repo at a time. */
export const deploy = async (ctx: DeployerContext, hostId: string, repo: string, source: string, dryRun: boolean): Promise<DeployOutcome> => {
  const { store, log } = ctx;
  const previous = await store.get(repo);
  const at = () => ctx.now().toISOString();
  const host = ctx.hosts[hostId];
  let client: RepoClient | undefined;
  let tree: ConfigTree | undefined;

  const fail = async (error: string, warnings?: string[]): Promise<DeployOutcome> => {
    log(`${repo}: deploy failed: ${error}`);
    if (!dryRun) {
      const record: StoredRecord = {
        host: hostId,
        repo,
        source,
        state: "failed",
        at: at(),
        error,
        ...(tree && { commit: tree.commit }),
        ...(warnings?.length && { warnings }),
        ...(previous?.deployed && { deployed: previous.deployed }),
      };
      await store.put(record);
      await writeStatus(ctx, client, record);
    }
    return { repo, outcome: "failed", error, ...(warnings?.length && { warnings }) };
  };

  if (!host) return fail(`achq doesn't know the repo host "${hostId}"`);
  if (!host.repoName.test(repo)) return fail(`"${repo}" isn't a repository name on ${hostId}`);
  // A stranger can install a public App. Their repo is recorded as failed but
  // never touched: no token is minted and nothing is read or evaluated.
  if (!ctx.owners.has(repo.split("/")[0]!.toLowerCase())) return fail(`${repo.split("/")[0]} isn't an owner this deployer serves`);

  try {
    const policy = host.deployerPolicy(source, repo);
    const credentials = await ctx.router.mint({ repo, policies: [policy] });
    const credential = credentials.find((c) => c.access === policy.access);
    if (!credential) throw new DeployFailure(`the router minted no ${policy.access} credential for ${source} on ${repo}`);
    client = host.repo(repo, credential);
  } catch (error) {
    return fail(`couldn't get a token for ${repo} from ${source}: ${message(error)}`);
  }

  try {
    tree = await client.config();
    const last = previous?.deployed;
    if (previous?.state === "deployed" && previous.host === hostId && previous.source === source && tree.tree && last?.tree === tree.tree) {
      log(`${repo}: .achq/ unchanged at ${tree.commit}`);
      return { repo, outcome: "unchanged", plan: last.plan, ...(previous.warnings && { warnings: previous.warnings }) };
    }
    if (!tree.tree || !tree.blobs.has("config.ts")) throw new DeployFailure(`there's no .achq/config.ts on ${tree.branch}`);
    const files = await client.download(tree, [...tree.blobs.keys()].filter(isSourceFile), ctx.fileLimits);

    let plan: RepoPlan;
    try {
      plan = await ctx.evaluate(files);
    } catch (error) {
      throw new DeployFailure(`.achq/config.ts: ${message(error)}`);
    }

    const { failures, warnings } = checkPlan(plan, { source, tree, sources: await ctx.router.sources(), policySource: ctx.policySource });
    const policies = plan.policies.map((p) => p.policy);
    if (policies.length) {
      const { problems } = await ctx.router.validate({ repo, policies });
      failures.push(...problems);
    }
    if (failures.length) return fail(failures.join("; "), warnings);
    if (dryRun) return { repo, outcome: "deployed", plan, ...(warnings.length && { warnings }) };

    // Only a new container, a moved image or a changed Dockerfile needs a
    // build. Containers load their config and credentials at runtime, so
    // anything else is just a router config update.
    const images: Record<string, ImageRecord> = {};
    const routerContainers: RouterRepoConfig["containers"] = [];
    const located: NonNullable<DeployRecord["containers"]> = [];
    for (const c of plan.containers) {
      const dockerfile = `.achq/${normaliseRepoPath(c.image)!}`;
      const blob = tree.blobs.get(dockerfile.slice(".achq/".length))!.sha;
      const { url } = await ctx.containerHost.ensure({
        host: hostId,
        repo,
        name: c.name,
        dockerfile,
        branch: tree.branch,
        env: {
          ...ctx.env.containerEnv,
          [ENV.repo]: repo,
          [ENV.repoUrl]: host.cloneUrl(repo),
          [ENV.container]: c.name,
          [ENV.containerSecret]: containerSecret(ctx.env.key, repo, c.name),
          [ENV.routerUrl]: ctx.env.routerUrl,
          [ENV.ref]: ctx.env.ref,
          [ENV.privateEnv]: ctx.env.privateEnv.join(","),
          PORT: String(CONTAINER_PORT),
        },
      });
      const before = previous?.deployed?.images[c.name];
      if (!before || before.dockerfile !== dockerfile || before.blob !== blob) {
        log(`${repo}: building ${c.name} from ${dockerfile}`);
        await ctx.containerHost.deploy(repo, c.name);
      }
      images[c.name] = { dockerfile, blob };
      routerContainers.push({ name: c.name, url, policies: c.policies.map((n) => plan.policies.find((p) => p.name === n)!.policy) });
    }
    // Containers removed from the config are left alone, asleep; only `sync({ prune })` deletes them.

    await ctx.router.putRepo({
      host: hostId,
      repo,
      commit: tree.commit,
      containers: routerContainers,
      workspaces: plan.workspaces,
      triggers: plan.triggers.map((t) => ({ name: t.name, event: t.event })),
    });
    for (const c of plan.containers) located.push({ name: c.name, location: await ctx.containerHost.locate(repo, c.name) });

    const record: StoredRecord = {
      host: hostId,
      repo,
      source,
      state: "deployed",
      at: at(),
      commit: tree.commit,
      containers: located,
      ...(warnings.length && { warnings }),
      deployed: { tree: tree.tree, plan, images },
    };
    await store.put(record);
    await writeStatus(ctx, client, record);
    log(`${repo}: deployed ${tree.commit}`);
    return { repo, outcome: "deployed", plan, ...(warnings.length && { warnings }) };
  } catch (error) {
    return fail(message(error));
  }
};
