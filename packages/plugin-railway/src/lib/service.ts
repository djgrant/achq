import { type Change, type Context, known, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { async } from "@achq/utils/async";
import type { Instance, InstanceSettings, PrivateEndpoint, ProjectAt, ServiceDomain } from "@achq/utils/railway";
import { railwayFromEnv } from "./railway.ts";
import { PLUGIN } from "../plugin.ts";

type ServiceProps = {
  at: ProjectAt;
  name: string;
  settings: InstanceSettings;
  volume: string;
  /** The port its public domain targets. Without one, any public domain is removed. */
  publicPort?: number;
  /** Set false to turn off deploys on push once it's connected to a repo. */
  autoDeploy?: false;
};

type ServiceState = {
  serviceId: string;
  instance: Instance;
  volumes: string[];
  endpoint?: PrivateEndpoint;
  domains: ServiceDomain[];
  /** Whether it deploys on push. Only read when it's to be off; otherwise taken as off. */
  autoDeploy: boolean;
};

type ServiceOutputs = { serviceId: string; url?: string };

type ServiceChange =
  | { kind: "service" }
  | { kind: "settings"; fields: string[] }
  | { kind: "volume" }
  | { kind: "hostname"; from: string }
  | { kind: "drop-domain"; id: string; domain: string }
  | { kind: "add-domain" }
  | { kind: "auto-deploy" };

/** Railway gives unset settings as null or not at all. */
const norm = (v: unknown) => (v === undefined ? null : v);

const https = (domain: string | undefined) => (domain ? `https://${domain}` : undefined);

const isPublic = (props: ServiceProps, domain: ServiceDomain) => Boolean(props.publicPort) && domain.targetPort === props.publicPort;

const kept = (props: ServiceProps, current: ServiceState | undefined) => current?.domains.find((d) => isPublic(props, d));

export class Service extends ManagedResource<ServiceProps, ServiceState, ServiceOutputs, ServiceChange> {
  readonly plugin = PLUGIN;
  readonly kind = "railway-service";

  async read(props: ServiceProps, ctx: Context) {
    if (!known(props.at.projectId)) return undefined;
    const found = await railwayFromEnv(ctx.env).project(props.at).serviceByName(props.name);
    if (!found) return undefined;
    const { service, volumes } = found;
    // Only what `props` asks for is read beyond its instance, domains and endpoint.
    const read = await async.allOf({
      instance: service.instance(),
      domains: service.domains(),
      endpoint: service.privateEndpoint(),
      // Railway can fail to say, for a service it can't deploy yet: that's taken as off.
      autoDeploy: props.autoDeploy === false ? service.autoDeploy().catch(() => false) : false,
    });
    return {
      serviceId: service.id,
      instance: read.instance,
      volumes: volumes.map((v) => v.mountPath),
      endpoint: read.endpoint,
      domains: read.domains,
      autoDeploy: read.autoDeploy,
    };
  }

  diff(props: ServiceProps, current: ServiceState | undefined): ServiceChange[] {
    if (!current) return [{ kind: "service" }, { kind: "volume" }, ...(props.publicPort ? [{ kind: "add-domain" } as const] : [])];
    const changes: ServiceChange[] = [];
    // A source is compared by image only: connecting a container's service to its repo sets the repo.
    const fields = (Object.keys(props.settings) as (keyof InstanceSettings)[]).filter((key) =>
      key === "source" ? norm(props.settings.source?.image) !== norm(current.instance.source?.image) : norm(props.settings[key]) !== norm(current.instance[key]),
    );
    if (fields.length) changes.push({ kind: "settings", fields });
    if (!current.volumes.includes(props.volume)) changes.push({ kind: "volume" });
    // Its private hostname is its name. A service that has never deployed has no endpoint yet, and gets one from its name.
    if (current.endpoint && current.endpoint.dnsName !== props.name) changes.push({ kind: "hostname", from: current.endpoint.dnsName });
    // Every domain but those on the public port goes, and one is added there if it has none.
    for (const d of current.domains) if (!isPublic(props, d)) changes.push({ kind: "drop-domain", id: d.id, domain: d.domain });
    if (props.publicPort && !kept(props, current)) changes.push({ kind: "add-domain" });
    if (current.autoDeploy) changes.push({ kind: "auto-deploy" });
    return changes;
  }

  describe(change: ServiceChange, { name, volume, publicPort }: ServiceProps): Change {
    switch (change.kind) {
      case "service":
        return { op: "+", target: name, what: "service" };
      case "settings":
        return { op: "~", target: name, what: "settings", detail: change.fields.join(", ") };
      case "volume":
        return { op: "+", target: name, what: "volume", detail: volume };
      case "hostname":
        return { op: "~", target: name, what: "private hostname", detail: `${change.from} → ${name}` };
      case "drop-domain":
        return { op: "-", target: name, what: "public domain", detail: change.domain };
      case "add-domain":
        return { op: "+", target: name, what: "public domain", detail: `→ :${publicPort}` };
      case "auto-deploy":
        return { op: "-", target: name, what: "automatic deploys" };
    }
  }

  planned(props: ServiceProps, current: ServiceState | undefined, changes: ServiceChange[]): Planned<ServiceOutputs> {
    return {
      serviceId: current?.serviceId ?? UNKNOWN,
      url: changes.some((c) => c.kind === "add-domain") ? UNKNOWN : https(kept(props, current)?.domain),
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
    return { serviceId: service!.id, url: https(domain) };
  }
}
