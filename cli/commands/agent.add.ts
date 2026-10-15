import { defineCommand } from "@pokit/core";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  agentEnv,
  appInstallation,
  ghApi,
  type Hook,
  need,
  Railway,
  saveSecret,
  serviceName,
  webhookSecret,
} from "../lib/agent.ts";

const PORT = 3000;

export const command = defineCommand({
  label: "Deploy the GitHub agent for a repo on Railway and point the repo's webhook at it",
  examples: ["ak agent add notationlabs/yieldstar"],
  context: {
    repo: {
      from: "arg",
      schema: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/repo"),
      description: "GitHub repo with an .agentkit/Dockerfile",
    },
  },
  run: async (r, { context }) => {
    const { repo } = context;
    const env = agentEnv();
    const railway = new Railway(need(env, "RAILWAY_API_TOKEN", "Create an account token at https://railway.com/account/tokens."));
    const claudeToken = need(env, "CLAUDE_CODE_OAUTH_TOKEN", "Run `claude setup-token`.");
    if (!env.AGENT_WEBHOOK_KEY) saveSecret("AGENT_WEBHOOK_KEY", (env.AGENT_WEBHOOK_KEY = randomBytes(32).toString("hex")));

    r.reporter.step(`Checking ${repo}`);
    const { default_branch } = await ghApi<{ default_branch: string }>("GET", `repos/${repo}`);
    await ghApi("GET", `repos/${repo}/contents/.agentkit/Dockerfile?ref=${default_branch}`).catch(() => {
      throw new Error(`${repo} has no .agentkit/Dockerfile on ${default_branch}`);
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
        { input: { name: "agentkit", workspaceId } },
      ));
      saveSecret("RAILWAY_PROJECT_ID", projectId);
      r.reporter.info(`Created project ${projectId}`);
    }
    const project = await railway.project(projectId);
    const { environmentId } = project;
    const name = serviceName(repo);
    let service: { id: string; deployment?: unknown } | undefined = project.services.find((s) => s.name === name);

    const variables = {
      AGENT_REPO: repo,
      PORT: String(PORT),
      GITHUB_APP_ID: need(env, "GITHUB_APP_ID", "Run `ak agent app`."),
      GITHUB_APP_PRIVATE_KEY: need(env, "GITHUB_APP_PRIVATE_KEY", "Run `ak agent app`."),
      GITHUB_WEBHOOK_SECRET: webhookSecret(env.AGENT_WEBHOOK_KEY, repo),
      CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
    };
    const settings = {
      builder: "DOCKERFILE",
      dockerfilePath: ".agentkit/Dockerfile",
      // Only changes to the agent's image redeploy it. A redeploy stops running sessions.
      watchPatterns: [".agentkit/**"],
      healthcheckPath: "/",
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

    await railway.gql(
      `mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }`,
      { serviceId, environmentId, input: settings },
    );
    await railway.gql(`mutation ($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`, {
      input: { projectId, environmentId, serviceId, variables, skipDeploys: true },
    });
    if (!project.volumes.some((v) => v.serviceId === serviceId)) {
      await railway.gql(`mutation ($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }`, {
        input: { projectId, environmentId, serviceId, mountPath: "/data" },
      });
      r.reporter.info("Attached a volume at /data");
    }
    let domain = await railway.serviceDomain(projectId, environmentId, serviceId);
    if (!domain) {
      ({ serviceDomainCreate: { domain } } = await railway.gql<{ serviceDomainCreate: { domain: string } }>(
        `mutation ($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
        { input: { environmentId, serviceId, targetPort: PORT } },
      ));
    }

    if (deployed) {
      r.reporter.info("Service already deployed. Settings and variables are updated; they apply on the next deploy.");
    } else {
      // Connecting the repo last means the first build already has the settings above.
      await railway.gql(
        `mutation ($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }`,
        { id: serviceId, input: { repo, branch: default_branch } },
      );
      r.reporter.info(`Connected ${repo}@${default_branch}; Railway is building .agentkit/Dockerfile`);
    }

    r.reporter.step("GitHub webhook");
    const url = `https://${domain}/webhook`;
    const hooks = await ghApi<Hook[]>("GET", `repos/${repo}/hooks`);
    const existing = hooks.find((h) => h.config.url === url);
    const hook = {
      active: true,
      events: ["issue_comment"],
      config: { url, content_type: "json", insecure_ssl: "0", secret: variables.GITHUB_WEBHOOK_SECRET },
    };
    if (existing) await ghApi("PATCH", `repos/${repo}/hooks/${existing.id}`, hook);
    else await ghApi("POST", `repos/${repo}/hooks`, { name: "web", ...hook });

    r.reporter.success(`${repo} → https://${domain}`);
    r.reporter.info(`Shell in with: railway ssh --project ${projectId} --service ${name}`);
  },
});
