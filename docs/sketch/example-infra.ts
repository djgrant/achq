import { Deployer, Router } from "./primitives.ts";
import { GitHubApp, RailwayContainerHost, RailwayRouterHost } from "./example-providers.ts";

const project = { project: "achq" };

const router = new Router("router", { host: new RailwayRouterHost(project) });

const deployer = new Deployer("deployer", {
  router,
  containerHost: new RailwayContainerHost({ ...project, sleep: true }),
  owners: ["djgrant", "notationlabs"],
});

new GitHubApp("personal", { name: "djgrant-claude", router, deployer });
new GitHubApp("notation", { name: "notation-achq", org: "notationlabs", router, deployer });
