import { randomBytes } from "node:crypto";
import { ENV, type Expander, type RouterEnv, type RouterHandle, ROUTER_PRIVATE_PORT, ROUTER_PUBLIC_PORT, type SecretStore } from "@achq/core";
import type { Node, Out } from "@achq/reconcile";
import { BUN_IMAGE } from "../../constants.ts";
import { Router } from "../../resources.ts";
import { hostServiceName, publicBase } from "../names.ts";
import { domainFor } from "../resources/domains.ts";
import { type Project, project } from "../resources/project.ts";
import { generated, secret } from "../resources/secret.ts";
import type { ServiceSettings } from "../resources/service.ts";
import { sharedVariables } from "../resources/shared-variables.ts";
import { addDeployment, addService } from "../service-nodes.ts";
import { startCommand } from "../start-command.ts";
import type { RailwayInfraDeps } from "./deps.ts";
import { legacyRouterSecrets } from "./legacy-secrets.ts";
import { waitForDeploy } from "./wait.ts";

/** A Railway router's handle also gives the deployer its project and service, for the private network. */
export type RailwayRouterHandle = RouterHandle & { readonly place: Node<Project>; readonly service: string };

const merge = (envs: RouterEnv[]): Required<RouterEnv> => ({
  values: Object.assign({}, ...envs.map((e) => e.values)),
  secrets: envs.flatMap((e) => e.secrets ?? []),
});

/** The router: a public, always-on service in the infra's project, which also keeps its secrets as shared variables. */
export const routerExpander = (deps: RailwayInfraDeps): Expander<Router, RailwayRouterHandle> => ({
  resource: Router,
  expand(router, { graph: g }) {
    const { railway } = deps;
    const name = hostServiceName(router.name);
    const place = g.add(`railway project ${router.inputs.project}`, project(railway), { name: router.inputs.project, workspaceId: deps.workspaceId });
    const secrets = g.derive<SecretStore>(`${router.inputs.project} shared variables`, async (o) => {
      const at = await o(place);
      return sharedVariables(railway, at, legacyRouterSecrets(railway, at, name));
    });
    const key = g.add(`secret ${ENV.key}`, secret, async (o) => ({
      store: await o(secrets),
      name: ENV.key,
      location: "store" as const,
      ...generated(deps.newKey ?? (() => randomBytes(32).toString("hex"))),
    }));

    const env = g.contribution<Node<RouterEnv>>();
    const environment = g.derive(`${name} environment`, async (o) => {
      const k = await o(key);
      const own: RouterEnv = {
        values: { [ENV.key]: k.ref, [ENV.ref]: deps.ref, PORT: String(ROUTER_PUBLIC_PORT), [ENV.privatePort]: String(ROUTER_PRIVATE_PORT) },
        secrets: [k],
      };
      return merge([own, ...(await Promise.all(env.all().map(o)))]);
    });

    const settings: ServiceSettings = { image: BUN_IMAGE, startCommand: startCommand("packages/router/src/main.ts"), healthcheckPath: "/", sleepApplication: false };
    const spec = {
      name,
      place,
      settings,
      ports: [ROUTER_PUBLIC_PORT],
      variables: async (o: Out) => (await o(environment)).values,
      secretDigests: async (o: Out) => (await o(environment)).secrets.map((s) => s.digest),
    };
    const service = addService(g, railway, spec);
    const deploy = addDeployment(g, railway, spec, service);

    const publicUrl = g.derive(`${name} public url`, async (o) => {
      const domain = domainFor(await o(service.domains), ROUTER_PUBLIC_PORT);
      if (!domain) throw new Error(`${name} has no public domain`);
      return (deps.publicBase ?? publicBase)(domain);
    });

    return {
      place,
      service: name,
      publicUrl,
      key,
      secrets,
      env,
      live: async (run) => {
        if (!run.changed(deploy)) return;
        await waitForDeploy(railway, run.output(place)!.environmentId, run.output(service.service)!.id, { what: "router", sleep: deps.sleep, log: deps.log });
      },
      access: async (run) => {
        const [base, k, store] = [run.output(publicUrl), run.output(key), run.output(secrets)];
        const found = base && k && store ? await store.read(k.name) : undefined;
        return found && base ? { base, key: found.value } : undefined;
      },
    };
  },
});
