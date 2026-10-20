// A service and what's fixed to it: its settings, volume, private hostname,
// public domain and whether it deploys on push. Not its variables: they're
// their own resource, so the service's URL is known before them. It can read
// them, though, as they were before this run: its `env`.
import { type Change, type Context, known, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { allOf } from "@achq/utils/async";
import type { FoundService, Instance, InstanceSettings, PrivateEndpoint, RailwayService, ServiceDomain } from "@achq/utils/railway";
import type { At } from "./project.ts";
import { railwayFromEnv } from "./railway.ts";

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
  /** Where its volumes are mounted. */
  volumes: string[];
  endpoint?: PrivateEndpoint;
  domains: ServiceDomain[];
  /** Whether it deploys on push. Only read when it's to be off; otherwise taken as off. */
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

/** Whether a domain is the public one: on the public port, when there is one. */
const isPublic = (props: ServiceProps, domain: ServiceDomain) => Boolean(props.publicPort) && domain.targetPort === props.publicPort;

/** The domain kept: the one on the public port. */
const kept = (props: ServiceProps, current: ServiceState | undefined) => current?.domains.find((d) => isPublic(props, d));

/** Its variables as read, before applying changes them: known, if none, while planning a new one. */
const env = (props: ServiceProps, current: ServiceState | undefined) => (props.env ? { env: current?.env ?? {} } : {});

// ── Reading ──────────────────────────────────────────────────────────────────

/** Whether it deploys on push. Railway can fail to say, for a service it can't deploy yet: that's taken as off. */
const deploysOnPush = (service: RailwayService) => service.autoDeploy().catch(() => false);

/** What's fixed to a service, read together. Only what `props` asks for is read beyond its instance, domains and endpoint. */
const readInstanceState = async ({ service, volumes }: FoundService, props: ServiceProps): Promise<ServiceState> => {
  const read = await allOf({
    instance: service.instance(),
    domains: service.domains(),
    endpoint: service.privateEndpoint(),
    autoDeploy: props.autoDeploy === false ? deploysOnPush(service) : false,
    env: props.env ? service.variables() : undefined,
  });
  return {
    serviceId: service.id,
    instance: read.instance,
    volumes: volumes.map((v) => v.mountPath),
    endpoint: read.endpoint,
    domains: read.domains,
    autoDeploy: read.autoDeploy,
    ...(read.env && { env: read.env }),
  };
};

// ── Comparing ────────────────────────────────────────────────────────────────

/** A service that doesn't exist yet gets made, with its volume and, if it's public, a domain. */
const newServiceChanges = (props: ServiceProps): ServiceChange[] => [{ kind: "service" }, { kind: "volume" }, ...(props.publicPort ? [{ kind: "add-domain" } as const] : [])];

const settingsChange = (props: ServiceProps, current: ServiceState): ServiceChange[] => {
  const fields = settingsDiff(props.settings, current.instance);
  return fields.length ? [{ kind: "settings", fields }] : [];
};

const volumeChange = (props: ServiceProps, current: ServiceState): ServiceChange[] => (current.volumes.includes(props.volume) ? [] : [{ kind: "volume" }]);

/** Its private hostname is its name. A service that has never deployed has no endpoint yet, and gets one from its name. */
const hostnameChange = (props: ServiceProps, current: ServiceState): ServiceChange[] =>
  current.endpoint && current.endpoint.dnsName !== props.name ? [{ kind: "hostname", from: current.endpoint.dnsName }] : [];

/** Every domain but those on the public port goes, and one is added there if it has none. */
const domainChanges = (props: ServiceProps, current: ServiceState): ServiceChange[] => {
  const drops = current.domains.filter((d) => !isPublic(props, d)).map((d): ServiceChange => ({ kind: "drop-domain", id: d.id, domain: d.domain }));
  const add: ServiceChange[] = props.publicPort && !kept(props, current) ? [{ kind: "add-domain" }] : [];
  return [...drops, ...add];
};

const autoDeployChange = (current: ServiceState): ServiceChange[] => (current.autoDeploy ? [{ kind: "auto-deploy" }] : []);

/** A Railway service, found by name in its project. */
export class Service extends ManagedResource<ServiceProps, ServiceState, ServiceOutputs, ServiceChange> {
  readonly kind = "railway-service";

  async read(props: ServiceProps, ctx: Context) {
    if (!known(props.at.projectId)) return undefined;
    const found = await railwayFromEnv(ctx.env).project(props.at).serviceByName(props.name);
    return found && readInstanceState(found, props);
  }

  diff(props: ServiceProps, current: ServiceState | undefined): ServiceChange[] {
    if (!current) return newServiceChanges(props);
    return [
      ...settingsChange(props, current),
      ...volumeChange(props, current),
      ...hostnameChange(props, current),
      ...domainChanges(props, current),
      ...autoDeployChange(current),
    ];
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
    const project = railwayFromEnv(ctx.env).project(props.at);
    const { name, settings, volume, publicPort } = props;
    // Made by the first change when it doesn't exist yet.
    let service = current && project.service(current.serviceId);
    let domain = kept(props, current)?.domain;
    for (const change of changes) {
      switch (change.kind) {
        case "service":
          service = await project.createService(name);
          await service.update(settings);
          break;
        case "settings":
          await service!.update(settings);
          break;
        case "volume":
          await service!.addVolume(volume);
          break;
        case "hostname":
          await service!.renamePrivateEndpoint(current!.endpoint!, name);
          break;
        case "drop-domain":
          await service!.deleteDomain(change.id);
          break;
        case "add-domain":
          domain = await service!.addDomain(publicPort!);
          break;
        case "auto-deploy":
          await service!.setAutoDeploy(false);
          break;
      }
    }
    return { serviceId: service!.id, url: https(domain), ...env(props, current) };
  }
}
