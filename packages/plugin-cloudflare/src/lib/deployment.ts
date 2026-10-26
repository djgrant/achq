import { type Change, type Context, ENV, hasUnknown, known, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { async } from "@achq/utils/async";
import { collections } from "@achq/utils/collections";
import { crypto } from "@achq/utils/crypto";
import { connect, workerSecrets } from "./cloudflare.ts";
import { ANSWER_POLL_INTERVAL_MS, ANSWER_TIMEOUT_MS } from "./constants.ts";
import { KV_KEYS } from "./names.ts";
import { type WorkerConfig, workerSourceHash, wranglerDeploy } from "./wrangler.ts";
import { PLUGIN } from "../plugin.ts";

type Props = {
  namespaceId: string;
  config: WorkerConfig;
  /** Every group of its variables, as one map: they go in as its ACHQ_ENV secret. */
  variables: Record<string, string>;
  /** Its public URL, to wait on until its new version answers. */
  wait?: string;
};
type State = { deployed?: string };
type Outputs = { fingerprint: string };

const FINGERPRINT_CHARS = 16;

/**
 * A Worker's secrets can't be read back, so a hash of what it was deployed with
 * is kept in the namespace: its config, the achq Worker's source rather than
 * where the checkout is, and its variables, sorted so their order doesn't count.
 */
export const fingerprint = (config: WorkerConfig, variables: Record<string, string>) =>
  crypto.sha256Hex(JSON.stringify({ config: { ...config, main: undefined }, variables: collections.sortKeys(variables), worker: workerSourceHash() }), FINGERPRINT_CHARS);

/**
 * One of achq's services deployed as its Worker, with Wrangler: the achq
 * Worker from this checkout, its config, and its variables as secrets. A new
 * version restarts the service with them. With `wait`, applying waits until
 * the Worker answers on its public URL, which is the new version starting it.
 */
export class Deployment extends ManagedResource<Props, State, Outputs, "deploy"> {
  readonly plugin = PLUGIN;
  readonly kind = "cloudflare-deployment";

  async read({ namespaceId, config }: Props, ctx: Context) {
    if (!known(namespaceId)) return undefined;
    const cf = await connect(ctx.env);
    return { deployed: await cf.kv.get(namespaceId, KV_KEYS.deployed(config.name)) };
  }

  diff({ config, variables }: Props, current: State | undefined): "deploy"[] {
    return hasUnknown(config) || hasUnknown(variables) || current?.deployed !== fingerprint(config, variables) ? ["deploy"] : [];
  }

  describe(_: "deploy", { config }: Props): Change {
    return { op: "~", target: config.name, what: "deploy" };
  }

  planned({ config, variables }: Props): Planned<Outputs> {
    return { fingerprint: hasUnknown(config) || hasUnknown(variables) ? UNKNOWN : fingerprint(config, variables) };
  }

  async apply({ namespaceId, config, variables, wait }: Props, _current: State | undefined, _changes: "deploy"[], ctx: Context) {
    const cf = await connect(ctx.env);
    // Its internal key derives from AGENT_WEBHOOK_KEY among its variables.
    const key = variables[ENV.key];
    if (!key) throw new Error(`${config.name} has no ${ENV.key}, which its Worker's internal key derives from`);
    await wranglerDeploy(ctx.env, cf.accountId, config, workerSecrets(variables, key));
    const deployed = fingerprint(config, variables);
    // Recorded once it's deployed, so an interrupted run deploys next time.
    await cf.kv.put(namespaceId, KV_KEYS.deployed(config.name), deployed);
    if (!wait) return { fingerprint: deployed };

    ctx.log(`  waiting for the ${this.parent?.kind ?? config.name} to answer…`);
    await async.pollOrThrow(
      () => fetch(`${wait}/`).then((res) => res.ok, () => false),
      (ok) => ok,
      {
        intervalMs: ANSWER_POLL_INTERVAL_MS,
        timeoutMs: ANSWER_TIMEOUT_MS,
        sleep: ctx.sleep,
        timedOut: (after) => `${config.name} hasn't answered after ${after}; see its logs on Cloudflare`,
      },
    );
    return { fingerprint: deployed };
  }
}
