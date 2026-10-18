import type { Graph, Node, Out } from "@achq/reconcile";
import type { RailwayClient } from "../api.ts";
import { VOLUME } from "../constants.ts";
import { deployment, fingerprint } from "./resources/deployment.ts";
import { publicDomains } from "./resources/domains.ts";
import { privateHostname } from "./resources/hostname.ts";
import type { Place } from "./resources/project.ts";
import { type ServiceSettings, service } from "./resources/service.ts";
import { variables } from "./resources/variables.ts";
import { volume } from "./resources/volume.ts";

export type ServiceSpec = {
  name: string;
  place: Node<Place>;
  settings: ServiceSettings;
  /** The ports it has public domains for, ascending. Empty keeps it private. */
  ports: number[];
  variables: (out: Out) => Promise<Record<string, string>>;
};

/** A service, its private hostname, its volume, its public domains and its variables. */
export const addService = (g: Graph, railway: RailwayClient, spec: ServiceSpec) => {
  const { name } = spec;
  const node = g.add(`service ${name}`, service(railway), async (o) => ({ place: await o(spec.place), name, ...spec.settings }));
  /** Where the service's own resources are. */
  const on = async (o: Out) => ({ place: await o(spec.place), serviceId: (await o(node)).id });
  g.add(`${name} private hostname`, privateHostname(railway), async (o) => ({ ...(await on(o)), name }));
  g.add(`${name} volume`, volume(railway), async (o) => ({ ...(await on(o)), mountPath: VOLUME }));
  const domains = g.add(`${name} public domains`, publicDomains(railway), async (o) => ({ ...(await on(o)), ports: spec.ports }));
  const vars = g.add(`${name} variables`, variables(railway), async (o) => ({ ...(await on(o)), values: await spec.variables(o) }));
  return { service: node, domains, variables: vars, on };
};

/**
 * Deploys an image service whenever its settings, its variables or a secret
 * they refer to differ from its last deploy. Applied after both.
 */
export const addDeployment = (
  g: Graph,
  railway: RailwayClient,
  spec: ServiceSpec & { secretDigests: (out: Out) => Promise<string[]> },
  added: ReturnType<typeof addService>,
) =>
  g.add(`${spec.name} deploy`, deployment(railway), async (o) => {
    await o(added.variables);
    return { ...(await added.on(o)), fingerprint: fingerprint({ settings: spec.settings, variables: await spec.variables(o), secrets: await spec.secretDigests(o) }) };
  });
