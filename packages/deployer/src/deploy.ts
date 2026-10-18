// See "Subscribing", "Config changes", "Checks" and "Deploy results" in
// docs/achq-design.md.
import { CONTAINER_PORT, ENV, type DeployRecord, type RepoPlan, type RouterRepoConfig, type Status } from "@achq/core";
import { containerSecret } from "@achq/core/secrets";
import { checkPlan } from "./checks.ts";
import { type AchqTree, type GitHubRepo, githubRepo } from "./clients/github.ts";
import { isSourceFile, normaliseRepoPath } from "./config/index.ts";
import { DEPLOYER_PERMISSIONS, REPO } from "./constants.ts";
import type { DeployerContext } from "./context.ts";
import { resolvePolicy } from "./policies.ts";
import type { ImageRecord, StoredRecord } from "./store.ts";

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

const writeStatus = async (ctx: DeployerContext, gh: GitHubRepo | undefined, record: StoredRecord) => {
  if (!gh) return;
  const { plan: _plan, tree: _tree, deployed: _deployed, ...status } = record;
  try {
    await gh.writeStatus({ ...status, ...(ctx.env.routerPublicUrl && { router: ctx.env.routerPublicUrl }) } satisfies Status);
  } catch (error) {
    ctx.log(`${record.repo}: couldn't write ACHQ_STATUS: ${message(error)}`);
  }
};

/** Deploys `repo`'s `.achq/` as `source` (the App) sees it. Run one per repo at a time. */
export const deploy = async (ctx: DeployerContext, repo: string, source: string, dryRun: boolean): Promise<DeployOutcome> => {
  const { store, log } = ctx;
  const previous = await store.get(repo);
  const at = () => ctx.now().toISOString();
  let gh: GitHubRepo | undefined;
  let tree: AchqTree | undefined;

  const fail = async (error: string, warnings?: string[]): Promise<DeployOutcome> => {
    log(`${repo}: deploy failed: ${error}`);
    if (!dryRun) {
      const record: StoredRecord = {
        repo,
        source,
        state: "failed",
        at: at(),
        error,
        ...(tree && { commit: tree.commit, ...(tree.tree && { tree: tree.tree }) }),
        ...(warnings?.length && { warnings }),
        ...(previous?.deployed && { deployed: previous.deployed }),
      };
      await store.put(record);
      await writeStatus(ctx, gh, record);
    }
    return { repo, outcome: "failed", error, ...(warnings?.length && { warnings }) };
  };

  if (!REPO.test(repo)) return fail(`"${repo}" isn't a repository name`);
  // A stranger can install a public App. Their repo is recorded as failed but
  // never touched: no token is minted and nothing is read or evaluated.
  if (!ctx.owners.has(repo.split("/")[0]!.toLowerCase())) return fail(`${repo.split("/")[0]} isn't an owner this deployer serves`);

  try {
    const credentials = await ctx.router.mint({ repo, policies: [{ provider: "github", app: source, repo, permissions: { ...DEPLOYER_PERMISSIONS } }] });
    const token = credentials.find((c) => c.provider === "github")?.value;
    if (!token) throw new DeployFailure(`the router minted no GitHub token for ${source} on ${repo}`);
    gh = githubRepo(repo, token, ctx.githubBaseUrl);
  } catch (error) {
    return fail(`couldn't get a token for ${repo} from ${source}: ${message(error)}`);
  }

  try {
    tree = await gh.achqTree();
    if (previous?.state === "deployed" && previous.source === source && tree.tree && previous.tree === tree.tree) {
      log(`${repo}: .achq/ unchanged at ${tree.commit}`);
      return { repo, outcome: "unchanged", ...(previous.warnings && { warnings: previous.warnings }), ...(previous.plan && { plan: previous.plan }) };
    }
    if (!tree.tree || !tree.blobs.has("config.ts")) throw new DeployFailure(`there's no .achq/config.ts on ${tree.branch}`);
    const files = await gh.download(tree, [...tree.blobs.keys()].filter(isSourceFile), ctx.fileLimits);

    let plan: RepoPlan;
    try {
      plan = await ctx.evaluate(files);
    } catch (error) {
      throw new DeployFailure(`.achq/config.ts: ${message(error)}`);
    }

    const { failures, warnings } = checkPlan(plan, { source, tree, sources: await ctx.router.sources() });
    const policies = plan.policies.map((p) => resolvePolicy(p.policy, repo));
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
        repo,
        name: c.name,
        dockerfile,
        branch: tree.branch,
        env: {
          [ENV.repo]: repo,
          [ENV.container]: c.name,
          [ENV.containerSecret]: containerSecret(ctx.env.key, repo, c.name),
          [ENV.routerUrl]: ctx.env.routerUrl,
          [ENV.claudeToken]: ctx.env.claudeToken,
          [ENV.ref]: ctx.env.ref,
          PORT: String(CONTAINER_PORT),
        },
      });
      const before = previous?.deployed?.images[c.name];
      if (!before || before.dockerfile !== dockerfile || before.blob !== blob) {
        log(`${repo}: building ${c.name} from ${dockerfile}`);
        await ctx.containerHost.deploy(repo, c.name);
      }
      images[c.name] = { dockerfile, blob };
      routerContainers.push({ name: c.name, url, policies: c.policies.map((n) => resolvePolicy(plan.policies.find((p) => p.name === n)!.policy, repo)) });
    }
    // Containers removed from the config are left alone, asleep; only `sync({ prune })` deletes them.

    await ctx.router.putRepo({
      repo,
      commit: tree.commit,
      containers: routerContainers,
      workspaces: plan.workspaces,
      triggers: plan.triggers.map((t) => ({ name: t.name, event: t.event })),
    });
    for (const c of plan.containers) located.push({ name: c.name, location: await ctx.containerHost.locate(repo, c.name) });

    const record: StoredRecord = {
      repo,
      source,
      state: "deployed",
      at: at(),
      commit: tree.commit,
      tree: tree.tree,
      plan,
      containers: located,
      ...(warnings.length && { warnings }),
      deployed: { commit: tree.commit, tree: tree.tree, plan, images },
    };
    await store.put(record);
    await writeStatus(ctx, gh, record);
    log(`${repo}: deployed ${tree.commit}`);
    return { repo, outcome: "deployed", plan, ...(warnings.length && { warnings }) };
  } catch (error) {
    return fail(message(error));
  }
};
