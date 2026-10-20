// Railway can't say what a deploy was made from, so achq keeps a hash of an
// image service's settings and variables in DEPLOYED, and deploys whenever
// they hash differently.
import { type Change, type Context, known, ManagedResource, type Planned } from "@achq/core";
import { pollUntil } from "@achq/utils/async";
import { sortKeys } from "@achq/utils/collections";
import { sha256Hex } from "@achq/utils/crypto";
import { DEPLOY_STATUS, FAILED_DEPLOY_STATUSES, type InstanceSettings, type RailwayService } from "@achq/utils/railway";
import { DEPLOY_POLL_INTERVAL_MS, DEPLOY_TIMEOUT_MS, DEPLOYED } from "./constants.ts";
import type { At } from "./project.ts";
import { serviceAt } from "./railway.ts";

type Props = {
  at: At & { serviceId: string };
  service: string;
  fingerprint: string;
  wait: boolean;
};
type State = { deployed?: string; hasDeployed: boolean };
type Outputs = { fingerprint: string };

const FINGERPRINT_CHARS = 16;

/** What a deploy was made from, kept in DEPLOYED. Variables are sorted, so their order doesn't count. */
export const fingerprint = (spec: { settings: InstanceSettings; variables: Record<string, string> }) =>
  sha256Hex(JSON.stringify({ settings: spec.settings, variables: sortKeys(spec.variables) }), FINGERPRINT_CHARS);

const minutes = (ms: number) => `${ms / 60_000} minutes`;

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
    return { op: "~", target: `${service} deploy` };
  }

  planned({ fingerprint }: Props): Planned<Outputs> {
    return { fingerprint };
  }

  async apply(props: Props, _current: State | undefined, _changes: "deploy"[], ctx: Context) {
    const { at, fingerprint } = props;
    const service = serviceAt(ctx.env, at);
    await service.deployImage();
    // Recorded once the deploy has started, so an interrupted run deploys next time.
    await service.setVariables({ [DEPLOYED]: fingerprint });
    if (props.wait) {
      ctx.log(`  waiting for the ${this.parent?.kind ?? props.service} to deploy…`);
      await live(service, props.service, ctx);
    }
    return { fingerprint };
  }
}

/** Waits for the service's latest deploy to go live. One that fails, or takes longer than DEPLOY_TIMEOUT_MS, throws. */
const live = async (service: RailwayService, name: string, ctx: Context) => {
  const latestStatus = async () => {
    const status = (await service.instance()).latestDeployment?.status;
    if (status && FAILED_DEPLOY_STATUSES.includes(status)) throw new Error(`${name}'s deploy ${status.toLowerCase()}; see its logs on Railway`);
    return status;
  };
  const isLive = (status: string | undefined) => status === DEPLOY_STATUS.live;
  const went = await pollUntil(latestStatus, isLive, { intervalMs: DEPLOY_POLL_INTERVAL_MS, timeoutMs: DEPLOY_TIMEOUT_MS, sleep: ctx.sleep });
  if (!went) throw new Error(`${name} hasn't deployed after ${minutes(DEPLOY_TIMEOUT_MS)}`);
};
