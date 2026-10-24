import { type CodeHostProvider, type ContainerProvider, type Stores, type DeployerEnvelope, type FileLimits, type RepoManifest, repoName, type SyncRequest, type SyncResult } from "@achq/core";
import type { RouterAdmin } from "@achq/core/client";
import { async } from "@achq/utils/async";
import { collections } from "@achq/utils/collections";
import { errors } from "@achq/utils/errors";
import { HttpError } from "@achq/utils/http";
import { type Evaluate, evaluateConfig } from "./config/evaluate.ts";
import { deploy, repoClient } from "./deploy.ts";
import { createStore, type Store, type StoredRecord, wireRecord } from "./store.ts";

export const DEFAULT_FILE_LIMITS: FileLimits = { maxFiles: 200, maxBytes: 1024 * 1024 };

const NOT_FOUND = 404;

const containerId = (c: { repo: string; name: string }) => `${c.repo}/${c.name}`;

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
  /** The router, at its private URL. */
  router: RouterAdmin;
  codeHostProviders: Record<string, CodeHostProvider>;
  owners: string[];
  /** Where it keeps its records: its container provider's store. */
  stores: Stores;
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
type UninstallOptions = ActionOptions & {
  /** Deletes its ACHQ_STATUS too, while the App still reaches it: the infra is going, router and all. */
  clearStatus?: boolean;
};

export const createDeployer = (deps: DeployerDeps) => {
  const ctx: DeployerContext = {
    ...deps,
    store: createStore(deps.stores),
    evaluate: deps.evaluate ?? ((files) => evaluateConfig(files)),
    now: deps.now ?? (() => new Date()),
    log: deps.log ?? ((line) => console.log(line)),
    owners: new Set(deps.owners.map((o) => o.toLowerCase())),
    fileLimits: deps.fileLimits ?? DEFAULT_FILE_LIMITS,
  };
  // One deploy or uninstall per repo at a time.
  const perRepo = async.keyedQueue();
  const inflight = new Set<string>();

  /**
   * The containers to prune: each whose repo isn't installed, or whose manifest
   * (this sync's, or else the last deployed) doesn't have it. A repo that has
   * never deployed has none, so nothing of it goes while it's installed.
   */
  const pruned = async (installed: Map<string, unknown>, manifests: Map<string, RepoManifest>, records: StoredRecord[]) => {
    const deployed = new Map(records.map((r) => [repoName.key(r.repo), r.deployed?.manifest]));
    return (await ctx.containerProvider.list()).filter((c) => {
      const key = repoName.key(c.repo);
      const manifest = manifests.get(key) ?? deployed.get(key);
      return !installed.has(key) || (manifest && !manifest.containers.some((m) => m.name === c.name));
    });
  };

  const actions = {
    deploy: (host: string, repo: string, { dryRun = false }: ActionOptions = {}) => perRepo(repoName.key(repo), () => deploy(ctx, host, repo, dryRun)),

    uninstall: (host: string, repo: string, { dryRun = false, clearStatus = false }: UninstallOptions = {}) =>
      perRepo(repoName.key(repo), async () => {
        if (dryRun) return;
        const previous = await ctx.store.get(repo);
        // Before the router forgets it, as minting needs it. A failure is only logged: the repo goes either way.
        if (clearStatus) {
          const provider = collections.own(ctx.codeHostProviders, host);
          try {
            if (provider) await (await repoClient(ctx, provider, repo)).clearStatus();
          } catch (error) {
            ctx.log(`${repo}: couldn't delete ACHQ_STATUS: ${errors.message(error)}`);
          }
        }
        // One the router doesn't have is already out.
        await ctx.router.deleteRepo(repo).catch((error) => {
          if (!(error instanceof HttpError && error.status === NOT_FOUND)) throw error;
        });
        // Containers and volumes are kept, asleep. Reinstalling brings it all back.
        await ctx.store.put({ ...previous, error: undefined, warnings: undefined, action: undefined, host, repo, state: "uninstalled", at: ctx.now().toISOString() });
        ctx.log(`${repo}: uninstalled`);
      }),
  };

  return {
    ...actions,

    /** The achq commit it runs. */
    ref: ctx.env.ref,

    /** False for a delivery it had already handled. */
    handle: async ({ event }: DeployerEnvelope) => {
      // Claimed synchronously, so a concurrent duplicate sees it before either awaits.
      if (inflight.has(event.delivery)) return false;
      inflight.add(event.delivery);
      try {
        if (await ctx.store.handled(event.delivery)) return false;
        const { host } = event;
        // One by one: each repo gets its own deploy and its own ACHQ_STATUS.
        for (const repo of event.deploy) await actions.deploy(host, repo);
        for (const repo of event.uninstall) await actions.uninstall(host, repo);
        // Marked only once handled, so a crash part-way lets the router's replay finish the job.
        await ctx.store.markHandled(event.delivery);
        return true;
      } finally {
        inflight.delete(event.delivery);
      }
    },

    /**
     * Deploys every installed repo, uninstalls the rest, and with `prune` deletes
     * containers no installed repo's manifest has. `empty` syncs to no repos,
     * as `achq infra down` does, and deletes each one's ACHQ_STATUS: the router
     * it names is going.
     */
    sync: async ({ prune = false, dryRun = false, empty = false, expect }: SyncRequest = {}) => {
      const result: SyncResult = { deployed: [], unchanged: [], uninstalled: [], pruned: [], failed: [] };
      // By repo key: one per repo, however the code hosts spell its name.
      const installed = new Map(empty ? [] : (await ctx.router.installed()).map((i) => [repoName.key(i.repo), i]));
      const manifests = new Map<string, RepoManifest>();
      for (const { host, repo } of installed.values()) {
        const outcome = await actions.deploy(host, repo, { dryRun });
        if (outcome.outcome === "failed") result.failed.push({ repo, error: outcome.error ?? "failed" });
        else result[outcome.outcome].push(repo);
        if (outcome.manifest) manifests.set(repoName.key(repo), outcome.manifest);
      }

      const records = await ctx.store.all();
      const doomed = prune ? await pruned(installed, manifests, records) : [];
      const unexpected = expect && doomed.map(containerId).filter((c) => !expect.includes(c));
      if (unexpected?.length) throw new Error(`It would prune ${unexpected.join(", ")} too, which weren't expected`);

      for (const record of records) {
        if (record.state === "uninstalled" || installed.has(repoName.key(record.repo))) continue;
        await actions.uninstall(record.host, record.repo, { dryRun, clearStatus: empty });
        result.uninstalled.push(record.repo);
      }
      for (const c of doomed) {
        if (!dryRun) await perRepo(repoName.key(c.repo), () => ctx.containerProvider.remove(c.repo, c.name));
        result.pruned.push(containerId(c));
      }
      return result;
    },

    /** Every repo's record: what `achq infra status` shows from the infra. */
    status: async () => (await ctx.store.all()).map(wireRecord),
  };
};

export type Deployer = ReturnType<typeof createDeployer>;
