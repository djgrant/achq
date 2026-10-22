import { type Change, type Context, known, ManagedResource, type Planned } from "@achq/core";
import { async } from "@achq/utils/async";
import { collections } from "@achq/utils/collections";
import { crypto } from "@achq/utils/crypto";
import { DEPLOY_STATUS, FAILED_DEPLOY_STATUSES, type InstanceSettings, type ServiceAt } from "@achq/utils/railway";
import { DEPLOY_POLL_INTERVAL_MS, DEPLOY_TIMEOUT_MS, DEPLOYED } from "./constants.ts";
import { serviceAt } from "./railway.ts";

type Props = {
  at: ServiceAt;
  service: string;
  fingerprint: string;
  wait: boolean;
};
type State = { deployed?: string; hasDeployed: boolean };
type Outputs = { fingerprint: string };

const FINGERPRINT_CHARS = 16;

/** Railway can't say what a deploy was made from, so its hash is kept in DEPLOYED. Variables are sorted, so their order doesn't count. */
export const fingerprint = (spec: { settings: InstanceSettings; variables: Record<string, string> }) =>
  crypto.sha256Hex(JSON.stringify({ settings: spec.settings, variables: collections.sortKeys(spec.variables) }), FINGERPRINT_CHARS);

export class Deployment extends ManagedResource<Props, State, Outputs, "deploy"> {
  readonly kind = "railway-deployment";

  async read({ at }: Props, ctx: Context) {
    if (!known(at.serviceId)) return undefined;
    const service = serviceAt(ctx.env, at);
    const [variables, instance] = await Promise.all([service.variables(), service.instance()]);
    return { deployed: variables[DEPLOYED], hasDeployed: Boolean(instance.latestDeployment) };
  }

  diff({ fingerprint }: Props, current: State | undefined): "deploy"[] {
    return known(fingerprint) && current?.hasDeployed && current.deployed === fingerprint ? [] : ["deploy"];
  }

  describe(_: "deploy", { service }: Props): Change {
    return { op: "~", target: service, detail: "deploy" };
  }

  planned({ fingerprint }: Props): Planned<Outputs> {
    return { fingerprint };
  }

  /** With `wait`, it waits for the deploy to go live. One that fails, or takes longer than DEPLOY_TIMEOUT_MS, throws. */
  async apply({ at, service: name, fingerprint, wait }: Props, _current: State | undefined, _changes: "deploy"[], ctx: Context) {
    const service = serviceAt(ctx.env, at);
    await service.deployImage();
    // Recorded once the deploy has started, so an interrupted run deploys next time.
    await service.setVariables({ [DEPLOYED]: fingerprint });
    if (!wait) return { fingerprint };

    ctx.log(`  waiting for the ${this.parent?.kind ?? name} to deploy…`);
    const latestStatus = async () => {
      const status = (await service.instance()).latestDeployment?.status;
      if (status && FAILED_DEPLOY_STATUSES.includes(status)) throw new Error(`${name}'s deploy ${status.toLowerCase()}; see its logs on Railway`);
      return status;
    };
    const live = await async.pollUntil(latestStatus, (status) => status === DEPLOY_STATUS.live, { intervalMs: DEPLOY_POLL_INTERVAL_MS, timeoutMs: DEPLOY_TIMEOUT_MS, sleep: ctx.sleep });
    if (!live) throw new Error(`${name} hasn't deployed after ${DEPLOY_TIMEOUT_MS / 60_000} minutes`);
    return { fingerprint };
  }
}
