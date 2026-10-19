// Railway can't say what a deploy was made from, so achq keeps a hash of an
// image service's settings and variables in DEPLOYED, and deploys whenever
// they hash differently.
import { createHash } from "node:crypto";
import { type Change, type Context, known, ManagedResource, type Planned } from "@achq/core";
import { type InstanceSettings, type RailwayClient, railwayClient } from "../lib/client.ts";
import { DEPLOY_POLL_ATTEMPTS, DEPLOY_POLL_INTERVAL_MS, DEPLOYED } from "./constants.ts";
import type { At } from "./project.ts";

type Props = {
  at: At & { serviceId: string };
  service: string;
  fingerprint: string;
  /** Whether applying waits for the deploy to go live. */
  wait: boolean;
};
type State = { deployed?: string; hasDeployed: boolean };
type Outputs = { fingerprint: string };

const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/** What a deploy was made from, kept in DEPLOYED. */
export const fingerprint = (spec: { settings: InstanceSettings; variables: Record<string, string> }) =>
  createHash("sha256")
    .update(JSON.stringify({ settings: spec.settings, variables: sorted(spec.variables) }))
    .digest("hex")
    .slice(0, 16);

/** An image service's deploy. */
export class Deployment extends ManagedResource<Props, State, Outputs, "deploy"> {
  readonly kind = "railway-deployment";

  async read({ at }: Props, ctx: Context) {
    if (!known(at.serviceId)) return undefined;
    const railway = railwayClient(ctx.env);
    const [variables, instance] = await Promise.all([railway.variables(at.projectId, at.environmentId, at.serviceId), railway.instance(at.environmentId, at.serviceId)]);
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
    const railway = railwayClient(ctx.env);
    await railway.deployImage(at.environmentId, at.serviceId);
    // Recorded once the deploy has started, so an interrupted run deploys next time.
    await railway.setVariables(at.projectId, at.environmentId, at.serviceId, { [DEPLOYED]: fingerprint });
    if (props.wait) {
      ctx.log(`  waiting for the ${this.parent?.kind ?? props.service} to deploy…`);
      await this.live(railway, props, ctx);
    }
    return { fingerprint };
  }

  private async live(railway: RailwayClient, { at, service }: Props, ctx: Context) {
    for (let i = 0; i < DEPLOY_POLL_ATTEMPTS; i++) {
      const status = (await railway.instance(at.environmentId, at.serviceId)).latestDeployment?.status;
      if (status === "SUCCESS") return;
      if (status === "FAILED" || status === "CRASHED") throw new Error(`${service}'s deploy ${status.toLowerCase()}; see its logs on Railway`);
      await ctx.sleep(DEPLOY_POLL_INTERVAL_MS);
    }
    throw new Error(`${service} hasn't deployed after five minutes`);
  }
}
