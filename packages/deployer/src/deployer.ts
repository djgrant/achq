// The deployer: evaluates a repo's `.achq/` config in the sandbox, checks it,
// creates its containers, pushes its router config, and reports the outcome in
// the repo's ACHQ_STATUS variable. See "Subscribing", "Config changes",
// "Checks" and "Deploy results" in docs/achq-design.md.
import { CONTAINER_PORT, ENV, type DeployRecord, type EventEnvelope, type Installation, type SourceSettings, type Status, type SyncRequest, type SyncResult, type PolicyData, type RepoPlan, type ChannelEvent, type ContainerHost, type RouterRepoConfig } from "@achq/core";
import { containerSecret } from "@achq/core/secrets";
import { type Evaluate, evaluateConfig, isSourceFile, normaliseRepoPath } from "./config/index.ts";
import { type AchqTree, DEFAULT_FILE_LIMITS, type FileLimits, type GitHubRepo, githubRepo } from "./clients/github.ts";
import { RouterError, type RouterClient } from "./clients/router.ts";
import { createStore, type ImageRecord, type StoredRecord } from "./store.ts";

/**
 * What the deployer's own token needs on a repo: read `.achq/`, and write the
 * ACHQ_STATUS variable. `actions_variables` is the installation-token key for
 * the "Variables" repository permission: GitHub's REST docs say "GitHub Apps
 * must have the `actions_variables:write` repository permission" for
 * POST/PATCH /repos/{owner}/{repo}/actions/variables, and
 * https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
 * lists those endpoints under "Variables" (write). (The OpenAPI `app-permissions`
 * schema doesn't list the key, so this is from the endpoint docs.)
 */
export const DEPLOYER_PERMISSIONS = { contents: "read", metadata: "read", actions_variables: "write" } as const;

export type DeployerEnv = {
  claudeToken: string;
  /** AGENT_WEBHOOK_KEY, for each container's secret. */
  key: string;
  routerUrl: string;
  /** The router's public URL, for ACHQ_STATUS. */
  routerPublicUrl?: string;
  ref: string;
};

export type DeployerDeps = {
  containerHost: ContainerHost;
  router: RouterClient;
  owners: string[];
  dataDir: string;
  githubBaseUrl?: string;
  evaluate?: Evaluate;
  now?: () => Date;
  env: DeployerEnv;
  fileLimits?: FileLimits;
  log?: (line: string) => void;
};

export type DeployOutcome = {
  repo: string;
  outcome: "deployed" | "unchanged" | "failed";
  error?: string;
  warnings?: string[];
  /** The plan deployed (or, for a dry run, that would be). */
  plan?: RepoPlan;
};

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const lower = (s: string) => s.toLowerCase();
const ownerOf = (repo: string) => lower(repo.split("/")[0]!);

/** A failure that's reported as-is. */
class DeployFailure extends Error {}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `repo: null` means the config's own repo. */
export const resolvePolicy = (policy: PolicyData, repo: string): PolicyData => ("repo" in policy && policy.repo === null ? { ...policy, repo } : policy);

/** The source (App slug) a policy is for: GitHub policies name it as `app`. */
const policySource = (policy: PolicyData) => (typeof policy.app === "string" ? policy.app : typeof policy.source === "string" ? policy.source : undefined);

/** The checks in "Checks" and "Subscribing" that need nothing but the plan, the tree and the router's sources. */
export const checkPlan = (plan: RepoPlan, ctx: { source: string; tree: AchqTree; sources: SourceSettings[] }) => {
  const failures: string[] = [];
  const warnings: string[] = [];
  const known = (channel: string, source: string) => ctx.sources.find((s) => s.channel === channel && s.source === source);

  const named: { what: string; channel: string; source: unknown }[] = [
    ...plan.policies.map((p) => ({ what: `policy ${p.name}`, channel: p.policy.provider, source: policySource(p.policy) })),
    ...plan.workspaces.map((w) => ({ what: `workspace ${w.name}`, channel: w.threads.channel, source: w.threads.source })),
    ...plan.triggers.map((t) => ({ what: `trigger ${t.name}`, channel: t.event.channel, source: t.event.source })),
  ];
  for (const n of named) {
    if (typeof n.source !== "string" || !n.source) failures.push(`${n.what} names no source`);
    else if (!known(n.channel, n.source)) failures.push(`${n.what} names ${n.channel}:${n.source}, which the router doesn't know`);
  }
  const usesInstalled = plan.policies.some((p) => policySource(p.policy) === ctx.source) || plan.workspaces.some((w) => w.threads.source === ctx.source);
  if (!usesInstalled) failures.push(`no policy or workspace names ${ctx.source}, the App that was installed`);

  for (const c of plan.containers) {
    const path = normaliseRepoPath(c.image);
    if (!path) failures.push(`container ${c.name}'s image "${c.image}" isn't a path under .achq/`);
    else if (!ctx.tree.blobs.has(path)) failures.push(`container ${c.name}'s image .achq/${path} doesn't exist`);
  }

  for (const t of plan.triggers) {
    const settings = typeof t.event.source === "string" ? known(t.event.channel, t.event.source) : undefined;
    const event = t.event.event;
    if (settings && typeof event === "string" && !settings.events.includes(event))
      failures.push(`trigger ${t.name} wants ${event}, which ${settings.source} doesn't send`);
    const covered = plan.workspaces.some((w) => w.threads.channel === t.event.channel && w.threads.source === t.event.source);
    if (!covered) warnings.push(`trigger ${t.name} never runs: no workspace's threads come from ${t.event.channel}:${String(t.event.source)}`);
  }
  return { failures, warnings };
};

/**
 * The repos an installation event adds (`which: "added"`) or removes. The GitHub
 * channel lists them in `detail.added` / `detail.removed`, and every repo the
 * installation covers in `detail.repos` (for suspend and unsuspend).
 */
export const eventRepos = (event: ChannelEvent, which: "added" | "removed"): string[] => {
  const names = (listed: unknown) =>
    Array.isArray(listed)
      ? listed.map((r) => (typeof r === "string" ? r : r && typeof r === "object" && typeof (r as { full_name?: unknown }).full_name === "string" ? (r as { full_name: string }).full_name : undefined))
      : [];
  const all = [...names(event.detail?.[which]), ...names(event.detail?.repos), ...(event.repo ? [event.repo] : [])].filter((r): r is string => Boolean(r));
  return [...new Map(all.map((r) => [lower(r), r])).values()];
};

export const createDeployer = (deps: DeployerDeps) => {
  const store = createStore(deps.dataDir);
  const evaluate = deps.evaluate ?? ((files) => evaluateConfig(files));
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const owners = new Set(deps.owners.map(lower));
  const fileLimits = deps.fileLimits ?? DEFAULT_FILE_LIMITS;

  // One deploy or uninstall per repo at a time.
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(repo: string, run: () => Promise<T>): Promise<T> => {
    const key = lower(repo);
    const next = (chains.get(key) ?? Promise.resolve()).then(run, run);
    chains.set(key, next);
    const done = () => {
      if (chains.get(key) === next) chains.delete(key);
    };
    next.then(done, done);
    return next;
  };

  const writeStatus = async (gh: GitHubRepo | undefined, record: StoredRecord) => {
    if (!gh) return;
    const { plan: _plan, tree: _tree, deployed: _deployed, ...status } = record;
    try {
      await gh.writeStatus({ ...status, ...(deps.env.routerPublicUrl && { router: deps.env.routerPublicUrl }) } satisfies Status);
    } catch (error) {
      log(`${record.repo}: couldn't write ACHQ_STATUS: ${message(error)}`);
    }
  };

  const doDeploy = async (repo: string, source: string, dryRun: boolean): Promise<DeployOutcome> => {
    const previous = await store.get(repo);
    const at = () => now().toISOString();
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
        await writeStatus(gh, record);
      }
      return { repo, outcome: "failed", error, ...(warnings?.length && { warnings }) };
    };

    if (!REPO.test(repo)) return fail(`"${repo}" isn't a repository name`);
    // A stranger can install a public App. Their repo is recorded as failed but
    // never touched: no token is minted and nothing is read or evaluated.
    if (!owners.has(ownerOf(repo))) return fail(`${repo.split("/")[0]} isn't an owner this deployer serves`);

    try {
      const credentials = await deps.router.mint({ repo, policies: [{ provider: "github", app: source, repo, permissions: { ...DEPLOYER_PERMISSIONS } }] });
      const token = credentials.find((c) => c.provider === "github")?.value;
      if (!token) throw new DeployFailure(`the router minted no GitHub token for ${source} on ${repo}`);
      gh = githubRepo(repo, token, deps.githubBaseUrl);
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
      const files = await gh.download(tree, [...tree.blobs.keys()].filter(isSourceFile), fileLimits);

      let plan: RepoPlan;
      try {
        plan = await evaluate(files);
      } catch (error) {
        throw new DeployFailure(`.achq/config.ts: ${message(error)}`);
      }

      const { failures, warnings } = checkPlan(plan, { source, tree, sources: await deps.router.sources() });
      const policies = plan.policies.map((p) => resolvePolicy(p.policy, repo));
      if (policies.length) {
        const { problems } = await deps.router.validate({ repo, policies });
        failures.push(...problems);
      }
      if (failures.length) return fail(failures.join("; "), warnings);
      if (dryRun) return { repo, outcome: "deployed", plan, ...(warnings.length && { warnings }) };

      // Containers load their config at runtime for the commit the router
      // forwards, and fetch credentials for their policies from the router, so
      // only a new container, a moved image or a changed Dockerfile needs a
      // build. Everything else is a router config update (the lead's decision).
      const images: Record<string, ImageRecord> = {};
      const routerContainers: RouterRepoConfig["containers"] = [];
      const located: NonNullable<DeployRecord["containers"]> = [];
      for (const c of plan.containers) {
        const dockerfile = `.achq/${normaliseRepoPath(c.image)!}`;
        const blob = tree.blobs.get(dockerfile.slice(".achq/".length))!.sha;
        const { url } = await deps.containerHost.ensure({
          repo,
          name: c.name,
          dockerfile,
          branch: tree.branch,
          env: {
            [ENV.repo]: repo,
            [ENV.container]: c.name,
            [ENV.containerSecret]: containerSecret(deps.env.key, repo, c.name),
            [ENV.routerUrl]: deps.env.routerUrl,
            [ENV.claudeToken]: deps.env.claudeToken,
            [ENV.ref]: deps.env.ref,
            PORT: String(CONTAINER_PORT),
          },
        });
        const before = previous?.deployed?.images[c.name];
        if (!before || before.dockerfile !== dockerfile || before.blob !== blob) {
          log(`${repo}: building ${c.name} from ${dockerfile}`);
          await deps.containerHost.deploy(repo, c.name);
        }
        images[c.name] = { dockerfile, blob };
        routerContainers.push({ name: c.name, url, policies: c.policies.map((n) => resolvePolicy(plan.policies.find((p) => p.name === n)!.policy, repo)) });
      }
      // Containers removed from the config are left alone, asleep; only `sync({ prune })` deletes them.

      await deps.router.putRepo({
        repo,
        commit: tree.commit,
        containers: routerContainers,
        workspaces: plan.workspaces,
        triggers: plan.triggers.map((t) => ({ name: t.name, event: t.event })),
      });
      for (const c of plan.containers) located.push({ name: c.name, location: await deps.containerHost.locate(repo, c.name) });

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
      await writeStatus(gh, record);
      log(`${repo}: deployed ${tree.commit}`);
      return { repo, outcome: "deployed", plan, ...(warnings.length && { warnings }) };
    } catch (error) {
      return fail(message(error));
    }
  };

  const doUninstall = async (repo: string, source: string | undefined, dryRun: boolean) => {
    const previous = await store.get(repo);
    if (dryRun) return;
    try {
      await deps.router.deleteRepo(repo);
    } catch (error) {
      if (!(error instanceof RouterError && error.status === 404)) throw error;
    }
    // Containers and volumes are kept, asleep. Reinstalling brings it all back.
    const { error: _error, warnings: _warnings, ...rest } = previous ?? ({} as Partial<StoredRecord>);
    await store.put({ ...rest, repo, source: source ?? previous?.source ?? "", state: "uninstalled", at: now().toISOString() });
    log(`${repo}: uninstalled`);
  };

  const deploy = (repo: string, source: string, options: { dryRun?: boolean } = {}) => serial(repo, () => doDeploy(repo, source, Boolean(options.dryRun)));
  const uninstall = (repo: string, source?: string, options: { dryRun?: boolean } = {}) => serial(repo, () => doUninstall(repo, source, Boolean(options.dryRun)));

  const inflight = new Set<string>();

  /** Handles an event the router forwarded. Returns false for a delivery it had already handled. */
  const handle = async ({ event }: EventEnvelope): Promise<boolean> => {
    // Claimed synchronously, so a concurrent duplicate sees it before either awaits.
    if (inflight.has(event.delivery)) return false;
    inflight.add(event.delivery);
    try {
      if (await store.handled(event.delivery)) return false;
      const [kind, action] = event.type.split(".");
      const install = (kind === "installation" && (action === "created" || action === "unsuspend")) || (kind === "installation_repositories" && action === "added");
      const remove = (kind === "installation" && (action === "deleted" || action === "suspend")) || (kind === "installation_repositories" && action === "removed");
      // One by one: each repo gets its own deploy and its own ACHQ_STATUS.
      if (install) for (const repo of eventRepos(event, "added")) await deploy(repo, event.source);
      else if (remove) for (const repo of eventRepos(event, "removed")) await uninstall(repo, event.source);
      else if (kind === "push" && event.repo) await deploy(event.repo, event.source);
      // Marked only once handled, so a crash part-way lets the router's replay finish the job.
      await store.markHandled(event.delivery);
      return true;
    } finally {
      inflight.delete(event.delivery);
    }
  };

  const sync = async ({ prune = false, dryRun = false }: SyncRequest = {}): Promise<SyncResult> => {
    const result: SyncResult = { deployed: [], unchanged: [], uninstalled: [], pruned: [], failed: [] };
    const installations: Installation[] = await deps.router.installations();
    const installed = new Map(installations.map((i) => [lower(i.repo), i]));
    const plans = new Map<string, RepoPlan | undefined>();

    for (const i of installed.values()) {
      const outcome = await deploy(i.repo, i.source, { dryRun });
      if (outcome.outcome === "failed") result.failed.push({ repo: i.repo, error: outcome.error ?? "failed" });
      else result[outcome.outcome].push(i.repo);
      if (outcome.plan) plans.set(lower(i.repo), outcome.plan);
    }
    for (const record of await store.all()) {
      if (record.state === "uninstalled" || installed.has(lower(record.repo))) continue;
      await uninstall(record.repo, undefined, { dryRun });
      result.uninstalled.push(record.repo);
    }
    if (prune) {
      const records = new Map((await store.all()).map((r) => [lower(r.repo), r]));
      for (const c of await deps.containerHost.list()) {
        const key = lower(c.repo);
        // A repo still installed keeps every container its last known plan has.
        // With no known plan (it has never deployed), nothing of it is removed.
        const plan = plans.get(key) ?? records.get(key)?.deployed?.plan;
        const remove = !installed.has(key) || (plan !== undefined && !plan.containers.some((p) => p.name === c.name));
        if (!remove) continue;
        if (!dryRun) await deps.containerHost.remove(c.repo, c.name);
        result.pruned.push(`${c.repo}/${c.name}`);
      }
    }
    return result;
  };

  /** Every repo's record, without plans: what `achq status` shows from the infra. */
  const status = async (): Promise<DeployRecord[]> => (await store.all()).map(({ plan: _plan, deployed: _deployed, ...record }) => record);

  return { deploy, uninstall, handle, sync, status };
};

export type Deployer = ReturnType<typeof createDeployer>;
