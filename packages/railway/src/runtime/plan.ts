// Planning reads everything first and changes nothing. Only `apply` makes changes.
import { createHash } from "node:crypto";
import type { InstanceSettings, ProjectSnapshot, RailwayClient } from "../api.ts";
import { DEPLOYED } from "../constants.ts";

/** A planned change, for printing. Variable changes name the variables, never their values. */
export type Change = { op: "+" | "~" | "-"; target: string; detail?: string };

export const formatChange = (c: Change) => `${c.op} ${c.target}${c.detail ? ` ${c.detail}` : ""}`;

export type ServiceSpec = {
  name: string;
  settings: InstanceSettings;
  variables: Record<string, string>;
  /** Where its volume is mounted. */
  volume: string;
  /** The port its public domain targets. Without one, any public domain is removed. */
  publicPort?: number;
  /** Image services: deploy whenever the settings or variables differ from the last deploy. */
  redeploy?: boolean;
};

/** Where in Railway a plan applies. A plan made before the project exists fills this in when applying. */
export type Target = { projectId?: string; environmentId?: string };

export type ServiceState = {
  serviceId?: string;
  variables: Record<string, string>;
  domain?: string;
};

export type ServicePlan = {
  changes: Change[];
  current: ServiceState;
  apply(): Promise<{ serviceId: string; domain?: string; deployed: boolean }>;
};

const fingerprint = (spec: ServiceSpec) =>
  createHash("sha256")
    .update(JSON.stringify({ settings: spec.settings, variables: sorted(spec.variables) }))
    .digest("hex")
    .slice(0, 16);

const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

const norm = (v: unknown) => (v === undefined ? null : v);

/** The settings that differ, by name. */
export const settingsDiff = (want: InstanceSettings, have: InstanceSettings) =>
  (Object.keys(want) as (keyof InstanceSettings)[]).filter((key) => {
    if (key === "source") return norm(want.source?.image) !== norm(have.source?.image);
    return norm(want[key]) !== norm(have[key]);
  });

/** The variables to set: missing or different. Extra variables on the service are left alone. */
export const variablesDiff = (want: Record<string, string>, have: Record<string, string>) =>
  Object.keys(want).filter((key) => have[key] !== want[key]);

export const planService = async (
  railway: RailwayClient,
  target: Target,
  spec: ServiceSpec,
  project?: ProjectSnapshot,
): Promise<ServicePlan> => {
  const name = spec.name;
  const service = project?.services.find((s) => s.name === name);
  const changes: Change[] = [];

  if (!service || !project) {
    changes.push({ op: "+", target: `service ${name}` }, { op: "+", target: `${name} volume`, detail: spec.volume });
    if (spec.publicPort) changes.push({ op: "+", target: `${name} public domain`, detail: `→ :${spec.publicPort}` });
    if (spec.redeploy) changes.push({ op: "~", target: `${name} deploy` });
    return {
      changes,
      current: { variables: {} },
      apply: async () => {
        const { projectId, environmentId } = need(target);
        const serviceId = await railway.createService(projectId, environmentId, name);
        await railway.updateInstance(environmentId, serviceId, spec.settings);
        await railway.setVariables(projectId, environmentId, serviceId, spec.variables);
        await railway.createVolume(projectId, environmentId, serviceId, spec.volume);
        const domain = spec.publicPort ? await railway.createDomain(environmentId, serviceId, spec.publicPort) : undefined;
        if (spec.redeploy) await deploy(railway, projectId, environmentId, serviceId, spec);
        return { serviceId, domain, deployed: Boolean(spec.redeploy) };
      },
    };
  }

  const { id: projectId, environmentId } = project;
  const serviceId = service.id;
  const [instance, variables, domains, endpoint] = await Promise.all([
    railway.instance(environmentId, serviceId),
    railway.variables(projectId, environmentId, serviceId),
    railway.domains(projectId, environmentId, serviceId),
    railway.privateEndpoint(environmentId, serviceId),
  ]);

  const settings = settingsDiff(spec.settings, instance);
  if (settings.length) changes.push({ op: "~", target: `${name} settings`, detail: settings.join(", ") });
  const vars = variablesDiff(spec.variables, variables);
  if (vars.length) changes.push({ op: "~", target: `${name} variables`, detail: vars.join(", ") });

  const hasVolume = project.volumes.some((v) => v.serviceId === serviceId && v.mountPath === spec.volume);
  if (!hasVolume) changes.push({ op: "+", target: `${name} volume`, detail: spec.volume });

  // A service that has never deployed has no endpoint yet, and gets one from its name.
  const rename = endpoint && endpoint.dnsName !== name ? endpoint : undefined;
  if (rename) changes.push({ op: "~", target: `${name} private hostname`, detail: `${rename.dnsName} → ${name}` });

  const keep = spec.publicPort ? domains.find((d) => d.targetPort === spec.publicPort) : undefined;
  const drop = domains.filter((d) => d !== keep && (!spec.publicPort || d.targetPort !== spec.publicPort));
  for (const d of drop) changes.push({ op: "-", target: `${name} public domain`, detail: d.domain });
  if (spec.publicPort && !keep) changes.push({ op: "+", target: `${name} public domain`, detail: `→ :${spec.publicPort}` });

  const redeploy = Boolean(spec.redeploy) && (variables[DEPLOYED] !== fingerprint(spec) || !instance.latestDeployment);
  if (redeploy) changes.push({ op: "~", target: `${name} deploy` });

  return {
    changes,
    current: { serviceId, variables, domain: keep?.domain },
    apply: async () => {
      if (settings.length) await railway.updateInstance(environmentId, serviceId, spec.settings);
      if (vars.length) await railway.setVariables(projectId, environmentId, serviceId, Object.fromEntries(vars.map((k) => [k, spec.variables[k]])));
      if (!hasVolume) await railway.createVolume(projectId, environmentId, serviceId, spec.volume);
      if (rename) await railway.renamePrivateEndpoint(rename.id, rename.privateNetworkId, name);
      for (const d of drop) await railway.deleteDomain(d.id);
      const domain = keep?.domain ?? (spec.publicPort ? await railway.createDomain(environmentId, serviceId, spec.publicPort) : undefined);
      if (redeploy) await deploy(railway, projectId, environmentId, serviceId, spec);
      return { serviceId, domain, deployed: redeploy };
    },
  };
};

const deploy = async (railway: RailwayClient, projectId: string, environmentId: string, serviceId: string, spec: ServiceSpec) => {
  await railway.deployImage(environmentId, serviceId);
  // Recorded once the deploy has started, so an interrupted run deploys next time.
  await railway.setVariables(projectId, environmentId, serviceId, { [DEPLOYED]: fingerprint(spec) });
};

const need = (target: Target) => {
  if (!target.projectId || !target.environmentId) throw new Error("No Railway project to apply to");
  return { projectId: target.projectId, environmentId: target.environmentId };
};
