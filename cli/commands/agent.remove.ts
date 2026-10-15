import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { agentEnv, deployedRepos, findService, ghApi, type Hook, need, ownerRepo, Railway } from "../lib/agent.ts";

export const command = defineCommand({
  label: "Delete a repo's GitHub agent: its Railway service, volume and webhook",
  examples: ["ak agent remove notationlabs/yieldstar"],
  context: {
    repo: {
      from: "arg",
      schema: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/repo"),
      description: "GitHub repo",
      resolve: deployedRepos,
    },
  },
  run: async (r, { context }) => {
    const repo = ownerRepo(context.repo);
    const env = agentEnv();
    const railway = new Railway(need(env, "RAILWAY_API_TOKEN", ""));
    const project = await railway.project(need(env, "RAILWAY_PROJECT_ID", "Nothing has been deployed."));
    const service = findService(project.services, repo);

    const domain = await railway.serviceDomain(project.id, project.environmentId, service.id);
    if (domain) {
      const hooks = await ghApi<Hook[]>("GET", `repos/${repo}/hooks`);
      for (const hook of hooks.filter((h) => h.config.url === `https://${domain}/webhook`)) {
        await ghApi("DELETE", `repos/${repo}/hooks/${hook.id}`);
      }
    }
    await railway.gql(`mutation ($id: String!, $environmentId: String!) { serviceDelete(id: $id, environmentId: $environmentId) }`, {
      id: service.id,
      environmentId: project.environmentId,
    });
    // Deleting a service doesn't necessarily delete its volume, which holds every session.
    for (const volume of project.volumes.filter((v) => v.serviceId === service.id)) {
      await railway.gql(`mutation ($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`, { volumeId: volume.id });
    }
    r.reporter.success(`Removed the agent for ${repo}`);
  },
});
