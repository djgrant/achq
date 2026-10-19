// A service and what's fixed to it: its settings, volume, private hostname,
// public domain and whether it deploys on push. Not its variables: they're
// their own resource, so the service's URL is known before them. It can read
// them, though, as they were before this run: its `env`.
import { type Change, type Context, known, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { type Instance, type InstanceSettings, railwayClient } from "./client.ts";
import type { At } from "./project.ts";

export type ServiceProps = {
  at: At;
  name: string;
  settings: InstanceSettings;
  /** Where its volume is mounted. */
  volume: string;
  /** The port its public domain targets. Without one, any public domain is removed. */
  publicPort?: number;
  /** Set false to turn off deploys on push once it's connected to a repo. */
  autoDeploy?: false;
  /** Set to read its variables, for `env`: one more call per read, which a container's service doesn't need. */
  env?: true;
};

export type ServiceState = {
  serviceId: string;
  instance: Instance;
  volumes: string[];
  endpoint?: { id: string; privateNetworkId: string; dnsName: string };
  domains: { id: string; domain: string; targetPort: number | null }[];
  autoDeploy: boolean;
  /** Its variables when read, if asked for. */
  env?: Record<string, string>;
};

/** `env`, if asked for: its variables before this run changes them, none if it doesn't exist yet. */
export type ServiceOutputs = { serviceId: string; url?: string; env?: Record<string, string> };

export type ServiceChange =
  | { kind: "service" }
  | { kind: "settings"; fields: string[] }
  | { kind: "volume" }
  | { kind: "hostname"; from: string }
  | { kind: "drop-domain"; id: string; domain: string }
  | { kind: "add-domain" }
  | { kind: "auto-deploy" };

const norm = (v: unknown) => (v === undefined ? null : v);

/**
 * The settings that differ, by name. Railway gives unset settings as null or
 * not at all. A source is compared by image only: connecting a container's
 * service to its repo sets the repo.
 */
export const settingsDiff = (want: InstanceSettings, have: InstanceSettings) =>
  (Object.keys(want) as (keyof InstanceSettings)[]).filter((key) => {
    if (key === "source") return norm(want.source?.image) !== norm(have.source?.image);
    return norm(want[key]) !== norm(have[key]);
  });

const https = (domain: string | undefined) => (domain ? `https://${domain}` : undefined);

/** The domain kept: the one on the public port. */
const kept = (props: ServiceProps, current: ServiceState | undefined) =>
  props.publicPort ? current?.domains.find((d) => d.targetPort === props.publicPort) : undefined;

/** Its variables as read, before applying changes them: known, if none, while planning a new one. */
const env = (props: ServiceProps, current: ServiceState | undefined) => (props.env ? { env: current?.env ?? {} } : {});

/** A Railway service, found by name in its project. */
export class Service extends ManagedResource<ServiceProps, ServiceState, ServiceOutputs, ServiceChange> {
  readonly kind = "railway-service";

  async read({ at, name, autoDeploy, env }: ServiceProps, ctx: Context) {
    if (!known(at.projectId)) return undefined;
    const railway = railwayClient(ctx.env);
    const { projectId, environmentId } = at;
    const project = await railway.project(projectId);
    const serviceId = project.services.find((s) => s.name === name)?.id;
    if (!serviceId) return undefined;
    const [instance, domains, endpoint, autoDeploys, variables] = await Promise.all([
      railway.instance(environmentId, serviceId),
      railway.domains(projectId, environmentId, serviceId),
      railway.privateEndpoint(environmentId, serviceId),
      autoDeploy === false ? railway.autoDeploy(projectId, environmentId, serviceId).catch(() => false) : false,
      env ? railway.variables(projectId, environmentId, serviceId) : undefined,
    ]);
    const volumes = project.volumes.filter((v) => v.serviceId === serviceId).map((v) => v.mountPath);
    return { serviceId, instance, volumes, endpoint, domains, autoDeploy: autoDeploys, ...(variables && { env: variables }) };
  }

  diff(props: ServiceProps, current: ServiceState | undefined): ServiceChange[] {
    if (!current) return [{ kind: "service" }, { kind: "volume" }, ...(props.publicPort ? [{ kind: "add-domain" } as const] : [])];
    const changes: ServiceChange[] = [];
    const fields = settingsDiff(props.settings, current.instance);
    if (fields.length) changes.push({ kind: "settings", fields });
    if (!current.volumes.includes(props.volume)) changes.push({ kind: "volume" });
    // A service that has never deployed has no endpoint yet, and gets one from its name.
    if (current.endpoint && current.endpoint.dnsName !== props.name) changes.push({ kind: "hostname", from: current.endpoint.dnsName });
    const keep = kept(props, current);
    for (const d of current.domains) if (d !== keep && (!props.publicPort || d.targetPort !== props.publicPort)) changes.push({ kind: "drop-domain", id: d.id, domain: d.domain });
    if (props.publicPort && !keep) changes.push({ kind: "add-domain" });
    if (current.autoDeploy) changes.push({ kind: "auto-deploy" });
    return changes;
  }

  describe(change: ServiceChange, { name, volume, publicPort }: ServiceProps): Change {
    switch (change.kind) {
      case "service":
        return { op: "+", target: `service ${name}` };
      case "settings":
        return { op: "~", target: `${name} settings`, detail: change.fields.join(", ") };
      case "volume":
        return { op: "+", target: `${name} volume`, detail: volume };
      case "hostname":
        return { op: "~", target: `${name} private hostname`, detail: `${change.from} → ${name}` };
      case "drop-domain":
        return { op: "-", target: `${name} public domain`, detail: change.domain };
      case "add-domain":
        return { op: "+", target: `${name} public domain`, detail: `→ :${publicPort}` };
      case "auto-deploy":
        return { op: "-", target: `${name} automatic deploys` };
    }
  }

  planned(props: ServiceProps, current: ServiceState | undefined, changes: ServiceChange[]): Planned<ServiceOutputs> {
    return {
      serviceId: current?.serviceId ?? UNKNOWN,
      url: changes.some((c) => c.kind === "add-domain") ? UNKNOWN : https(kept(props, current)?.domain),
      ...env(props, current),
    };
  }

  async apply(props: ServiceProps, current: ServiceState | undefined, changes: ServiceChange[], ctx: Context) {
    const railway = railwayClient(ctx.env);
    const { at: { projectId, environmentId }, name, settings, volume, publicPort } = props;
    let serviceId = current?.serviceId as string;
    let domain = kept(props, current)?.domain;
    for (const change of changes) {
      switch (change.kind) {
        case "service":
          serviceId = await railway.createService(projectId, environmentId, name);
          await railway.updateInstance(environmentId, serviceId, settings);
          break;
        case "settings":
          await railway.updateInstance(environmentId, serviceId, settings);
          break;
        case "volume":
          await railway.createVolume(projectId, environmentId, serviceId, volume);
          break;
        case "hostname":
          await railway.renamePrivateEndpoint(current!.endpoint!.id, current!.endpoint!.privateNetworkId, name);
          break;
        case "drop-domain":
          await railway.deleteDomain(change.id);
          break;
        case "add-domain":
          domain = await railway.createDomain(environmentId, serviceId, publicPort!);
          break;
        case "auto-deploy":
          await railway.setAutoDeploy(projectId, environmentId, serviceId, false);
          break;
      }
    }
    return { serviceId, url: https(domain), ...env(props, current) };
  }
}
