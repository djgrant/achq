import { DEPLOYER_PORT, ENV, type Expander, ROUTER_PRIVATE_PORT } from "@achq/core";
import type { Out } from "@achq/reconcile";
import { BUN_IMAGE } from "../../constants.ts";
import { Deployer, Router } from "../../resources.ts";
import { hostServiceName, privateUrl } from "../names.ts";
import { given, secret } from "../resources/secret.ts";
import type { ServiceSettings } from "../resources/service.ts";
import { addDeployment, addService } from "../service-nodes.ts";
import { startCommand } from "../start-command.ts";
import type { RailwayInfraDeps } from "./deps.ts";
import type { RailwayRouterHandle } from "./router.ts";

/** The deployer: a private service in the router's project that sleeps when idle, and deploys containers to the same project. */
export const deployerExpander = (deps: RailwayInfraDeps): Expander<Deployer, void> => ({
  resource: Deployer,
  expand(deployer, { graph: g, handle }) {
    const { router } = deployer.inputs;
    if (!(router instanceof Router)) throw new Error(`Deployer ${deployer.name} needs a Railway router: use railway.Router`);
    if (router.inputs.project !== deployer.inputs.project) {
      throw new Error(`The router and deployer must share one Railway project (${router.inputs.project}), for its private network`);
    }
    const r = handle<RailwayRouterHandle>(router);
    const name = hostServiceName(deployer.name);
    r.env.add(g.derive(`${name} url`, () => ({ values: { [ENV.deployerUrl]: privateUrl(name, DEPLOYER_PORT) } })));

    const token = (variable: string, value: string) =>
      g.add(`secret ${variable}`, secret, async (o) => ({ store: await o(r.secrets), name: variable, location: "store" as const, ...given(value) }));
    const railwayToken = token("RAILWAY_API_TOKEN", deps.tokens.railway);
    const claudeToken = token(ENV.claudeToken, deps.tokens.claude);

    const environment = g.derive(`${name} environment`, async (o) => {
      const [at, key, rt, ct] = await Promise.all([o(r.place), o(r.key), o(railwayToken), o(claudeToken)]);
      return {
        values: {
          [ENV.key]: key.ref,
          [ENV.routerUrl]: privateUrl(r.service, ROUTER_PRIVATE_PORT),
          [ENV.routerPublicUrl]: await o(r.publicUrl),
          [ENV.owners]: deployer.inputs.owners.join(","),
          RAILWAY_API_TOKEN: rt.ref,
          ACHQ_RAILWAY_PROJECT_ID: at.projectId,
          ACHQ_RAILWAY_ENVIRONMENT_ID: at.environmentId,
          [ENV.claudeToken]: ct.ref,
          [ENV.ref]: deps.ref,
          PORT: String(DEPLOYER_PORT),
        },
        secrets: [key, rt, ct],
      };
    });

    const settings: ServiceSettings = { image: BUN_IMAGE, startCommand: startCommand("packages/deployer/src/main.ts"), healthcheckPath: "/", sleepApplication: true };
    const spec = {
      name,
      place: r.place,
      settings,
      ports: [],
      variables: async (o: Out) => (await o(environment)).values,
      secretDigests: async (o: Out) => (await o(environment)).secrets.map((s) => s.digest),
    };
    addDeployment(g, deps.railway, spec, addService(g, deps.railway, spec));
  },
});
