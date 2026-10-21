import { type CodeHostProvider, type ContainerProvider, type DeployerEnvelope, type FileLimits, type RepoManifest, repoName, type SyncRequest, type SyncResult } from "@achq/core";
import { async } from "@achq/utils/async";
import { HttpError } from "@achq/utils/http";
import { type Evaluate, evaluateConfig } from "./config/evaluate.ts";
import { deploy } from "./deploy.ts";
import type { RouterClient } from "./router-client.ts";
import { createStore, type Store, wireRecord } from "./store.ts";

export const DEFAULT_FILE_LIMITS: FileLimits = { maxFiles: 200, maxBytes: 1024 * 1024 };

const NOT_FOUND = 404;

export type DeployerEnv = {
  containerEnv: Record<string, string>;
  /** Variables a container never hands to an agent: every implementation's. */
  privateEnv: string[];
  /** AGENT_WEBHOOK_KEY, for each container's secret. */
  key: string;
  routerUrl: string;
  /** The router's public URL, for ACHQ_STATUS. */
  routerPublicUrl: string;
  ref: string;
};

export type DeployerDeps = {
  containerProvider: ContainerProvider;
  router: RouterClient;
  codeHostProviders: Record<string, CodeHostProvider>;
  owners: string[];
  dataDir: string;
  evaluate?: Evaluate;
  now?: () => Date;
  env: DeployerEnv;
  fileLimits?: FileLimits;
  log?: (line: string) => void;
};

export type DeployerContext = Required<Omit<DeployerDeps, "owners">> & {
  /** Lowercased. */
  owners: Set<string>;
  store: Store;
};

type ActionOptions = { dryRun?: boolean };

export const createDeployer = (deps: DeployerDeps) => {
  const ctx: DeployerContext = {
    ...deps,
    store: createStore(deps.dataDir),
    evaluate: deps.evaluate ?? ((files) => evaluateConfig(files)),
    now: deps.now ?? (() => new Date()),
    log: deps.log ?? ((line) => console.log(line)),
    owners: new Set(deps.owners.map((o) => o.toLowerCase())),
    fileLimits: deps.fileLimits ?? DEFAULT_FILE_LIMITS,
  };
  // One deploy or uninstall per repo at a time.
  const perRepo = async.keyedQueue();
  const inflight = new Set<string>();

  const actions = {
    deploy: (host: string, repo: string, { dryRun = false }: ActionOptions = {}) => perRepo(repoName.key(repo), () => deploy(ctx, host, repo, dryRun)),

    uninstall: (host: string, repo: string, { dryRun = false }: ActionOptions = {}) =>
      perRepo(repoName.key(repo), async () => {
        if (dryRun) return;
        const previous = await ctx.store.get(repo);
        // One the router doesn't have is already out.
        await ctx.router.deleteRepo(repo).catch((error) => {
          if (!(error instanceof HttpError && error.status === NOT_FOUND)) throw error;
        });
        // Containers and volumes are kept, asleep. Reinstalling brings it all back.
        await ctx.store.put({ ...previous, error: undefined, warnings: undefined, host, repo, state: "uninstalled", at: ctx.now().toISOString() });
        ctx.log(`${repo}: uninstalled`);
      }),
  };

  return {
    ...actions,

    /** False for a delivery it had already handled. */
    handle: async ({ event }: DeployerEnvelope) => {
      // Claimed synchronously, so a concurrent duplicate sees it before either awaits.
      if (inflight.has(event.delivery)) return false;
      inflight.add(event.delivery);
      try {
        if (await ctx.store.handled(event.delivery)) return false;
        const { host } = event;
        // One by one: each repo gets its own deploy and its own ACHQ_STATUS.
        if (event.installation) {
          for (const repo of event.installation.added) await actions.deploy(host, repo);
          for (const repo of event.installation.removed) await actions.uninstall(host, repo);
        } else if (event.configChanged && event.repo) await actions.deploy(host, event.repo);
        // Marked only once handled, so a crash part-way lets the router's replay finish the job.
        await ctx.store.markHandled(event.delivery);
        return true;
      } finally {
        inflight.delete(event.delivery);
      }
    },

    /** Deploys every installed repo, uninstalls the rest, and with `prune` deletes containers no manifest has. */
    sync: async ({ prune = false, dryRun = false }: SyncRequest = {}) => {
      const result: SyncResult = { deployed: [], unchanged: [], uninstalled: [], pruned: [], failed: [] };
      // By repo key: one per repo, however the code hosts spell its name.
      const installed = new Map((await ctx.router.installed()).map((i) => [repoName.key(i.repo), i]));
      const manifests = new Map<string, RepoManifest>();
      for (const { host, repo } of installed.values()) {
        const outcome = await actions.deploy(host, repo, { dryRun });
        if (outcome.outcome === "failed") result.failed.push({ repo, error: outcome.error ?? "failed" });
        else result[outcome.outcome].push(repo);
        if (outcome.manifest) manifests.set(repoName.key(repo), outcome.manifest);
      }

      for (const record of await ctx.store.all()) {
        if (record.state === "uninstalled" || installed.has(repoName.key(record.repo))) continue;
        await actions.uninstall(record.host, record.repo, { dryRun });
        result.uninstalled.push(record.repo);
      }

      if (prune) {
        const records = new Map((await ctx.store.all()).map((r) => [repoName.key(r.repo), r]));
        for (const c of await ctx.containerProvider.list()) {
          const key = repoName.key(c.repo);
          const manifest = manifests.get(key) ?? records.get(key)?.deployed?.manifest;
          // A container goes when its repo isn't installed, or its manifest (this sync's, or else the last deployed) doesn't have it.
          // A repo that has never deployed has none, so nothing of it goes while it's installed.
          if (installed.has(key) && (!manifest || manifest.containers.some((m) => m.name === c.name))) continue;
          if (!dryRun) await ctx.containerProvider.remove(c.repo, c.name);
          result.pruned.push(`${c.repo}/${c.name}`);
        }
      }
      return result;
    },

    /** Every repo's record: what `achq infra status` shows from the infra. */
    status: async () => (await ctx.store.all()).map(wireRecord),
  };
};

export type Deployer = ReturnType<typeof createDeployer>;
