import { defineCommand } from "@pokit/core";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  agentEnv,
  appInstallation,
  ensureRouter,
  ghApi,
  type Hook,
  lastCommit,
  need,
  ownerRepo,
  Railway,
  ROUTER,
  saveSecret,
  DEPLOYED,
  fingerprint,
  type ServiceSettings,
  serviceName,
  webhookSecret,
  repoSchema,
} from "../lib/agent.ts";

const PORT = 3000;

export const command = defineCommand({
  label: "Deploy a GitHub agent, or bring an existing one up to date",
  examples: ["achq deploy notationlabs/yieldstar"],
  context: {
    repo: {
      from: "arg",
      schema: repoSchema(z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/repo")),
      description: "GitHub repo with an .achq/Dockerfile",
    },
  },
  run: async (r, { context }) => {
    const repo = ownerRepo(context.repo);
    const env = agentEnv();
    const railway = new Railway(need(env, "RAILWAY_API_TOKEN", "Create an account token at https://railway.com/account/tokens."));
    const claudeToken = need(env, "CLAUDE_CODE_OAUTH_TOKEN", "Run `claude setup-token`.");
    if (!env.AGENT_WEBHOOK_KEY) saveSecret("AGENT_WEBHOOK_KEY", (env.AGENT_WEBHOOK_KEY = randomBytes(32).toString("hex")));

    r.reporter.step(`Checking ${repo}`);
    const { default_branch } = await ghApi<{ default_branch: string }>("GET", `repos/${repo}`);
    await ghApi("GET", `repos/${repo}/contents/.achq/Dockerfile?ref=${default_branch}`).catch(() => {
      throw new Error(`${repo} has no .achq/Dockerfile on ${default_branch}`);
    });
    if (!(await appInstallation(env, repo))) {
      throw new Error(`Install the App on ${repo} first: https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`);
    }

    r.reporter.step("Railway project");
    let projectId = env.RAILWAY_PROJECT_ID;
    if (!projectId) {
      const workspaceId = env.RAILWAY_WORKSPACE_ID ?? (await railway.workspaceId());
      ({ projectCreate: { id: projectId } } = await railway.gql<{ projectCreate: { id: string } }>(
        `mutation ($input: ProjectCreateInput!) { projectCreate(input: $input) { id } }`,
        { input: { name: "achq", workspaceId } },
      ));
      saveSecret("RAILWAY_PROJECT_ID", projectId);
      r.reporter.info(`Created project ${projectId}`);
    }
    const project = await railway.project(projectId);
    const { environmentId } = project;
    const name = serviceName(repo);
    let service: { id: string; deployment?: unknown } | undefined = project.services.find((s) => s.name === name);

    // Pins the image's achq, as a build arg; a changed ref also busts Railway's layer cache.
    const achqRef = await lastCommit("github-agent");
    const variables = {
      ACHQ_REF: achqRef,
      AGENT_REPO: repo,
      PORT: String(PORT),
      GITHUB_APP_ID: need(env, "GITHUB_APP_ID", "Run `achq app`."),
      GITHUB_APP_PRIVATE_KEY: need(env, "GITHUB_APP_PRIVATE_KEY", "Run `achq app`."),
      GITHUB_WEBHOOK_SECRET: webhookSecret(env.AGENT_WEBHOOK_KEY, repo),
      CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
    };
    const settings: ServiceSettings = {
      // Setting a Dockerfile path is what makes Railway build with Docker.
      dockerfilePath: ".achq/Dockerfile",
      // Only changes to the agent's image redeploy it. A redeploy stops running sessions.
      watchPatterns: [".achq/**"],
      healthcheckPath: "/",
      // Sleeps when idle; the router's forwarded webhooks wake it.
      sleepApplication: true,
    };

    if (!service) {
      r.reporter.step(`Creating service ${name}`);
      const { serviceCreate } = await railway.gql<{ serviceCreate: { id: string; name: string } }>(
        `mutation ($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
        { input: { projectId, environmentId, name } },
      );
      service = serviceCreate;
    }
    const serviceId = service.id;
    const deployed = Boolean(service.deployment);

    // Writes and redeploys only when the config differs from the last one deployed.
    const config = fingerprint({ variables, settings });
    const stale = (await railway.variables(projectId, environmentId, serviceId))[DEPLOYED] !== config;
    if (stale) {
      await railway.gql(
        `mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
          serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
        }`,
        { serviceId, environmentId, input: settings },
      );
      await railway.setVariables(projectId, environmentId, serviceId, variables);
    }
    if (!project.volumes.some((v) => v.serviceId === serviceId)) {
      await railway.gql(`mutation ($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }`, {
        input: { projectId, environmentId, serviceId, mountPath: "/data" },
      });
      r.reporter.info("Attached a volume at /data");
    }
    // The router reaches the service at <service name>.railway.internal.
    if (await railway.privateHostname(environmentId, serviceId, name)) {
      r.reporter.info(`Set its private hostname to ${name}.railway.internal`);
    }
    // Only the router is public. A public domain would let any request wake the service.
    const oldDomains = await railway.serviceDomains(projectId, environmentId, serviceId);
    for (const { id } of oldDomains) {
      await railway.gql(`mutation ($id: String!) { serviceDomainDelete(id: $id) }`, { id });
    }

    r.reporter.step("Router");
    const routerRef = await lastCommit("github-agent/src/router.ts");
    const router = await ensureRouter(railway, project, { ACHQ_REF: routerRef, AGENT_WEBHOOK_KEY: env.AGENT_WEBHOOK_KEY });
    r.reporter.info(router.deployed ? `Deploying ${ROUTER} with achq ${routerRef.slice(0, 7)}` : `${ROUTER} is up to date`);

    if (deployed && !stale) {
      r.reporter.info(`${name} is up to date with achq ${achqRef.slice(0, 7)}`);
    } else if (deployed) {
      await railway.gql(
        `mutation ($serviceId: String!, $environmentId: String!) {
          serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId, latestCommit: true)
        }`,
        { serviceId, environmentId },
      );
      r.reporter.info(`Redeploying ${name} with achq ${achqRef.slice(0, 7)}. Runs in progress are interrupted.`);
    } else {
      // Connecting the repo last means the first build already has the settings above.
      await railway
        .gql(
          `mutation ($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }`,
          { id: serviceId, input: { repo, branch: default_branch } },
        )
        .catch((error: Error) => {
          if (!/access to the repo/.test(error.message)) throw error;
          throw new Error(
            `Railway's GitHub app can't see ${repo}. Give it access at https://github.com/settings/installations (or the org's), then re-run.`,
          );
        });
      r.reporter.info(`Connected ${repo}@${default_branch}; Railway is building .achq/Dockerfile`);
    }

    // Recorded only once the deploy has started, so an interrupted run redeploys next time.
    if (stale) await railway.setVariables(projectId, environmentId, serviceId, { [DEPLOYED]: config });

    r.reporter.step("GitHub webhook");
    const url = `https://${router.domain}/webhook`;
    const hooks = await ghApi<Hook[]>("GET", `repos/${repo}/hooks`);
    for (const hook of hooks.filter((h) => oldDomains.some((d) => h.config.url === `https://${d.domain}/webhook`))) {
      await ghApi("DELETE", `repos/${repo}/hooks/${hook.id}`);
    }
    const existing = hooks.find((h) => h.config.url === url);
    const hook = {
      active: true,
      events: ["issue_comment"],
      config: { url, content_type: "json", insecure_ssl: "0", secret: variables.GITHUB_WEBHOOK_SECRET },
    };
    if (existing) await ghApi("PATCH", `repos/${repo}/hooks/${existing.id}`, hook);
    else await ghApi("POST", `repos/${repo}/hooks`, { name: "web", ...hook });

    r.reporter.success(`${repo} → ${url}`);
    r.reporter.info(deployed && !stale ? `Shell in with: achq ssh ${repo}` : `Shell in once it has deployed: achq ssh ${repo}`);
  },
});
