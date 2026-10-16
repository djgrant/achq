import { defineCommand } from "@pokit/core";
import { z } from "zod";
import { agentEnv, deployedRepos, findService, ghApi, type Hook, need, ownerRepo, Railway, ROUTER } from "../lib/agent.ts";

export const command = defineCommand({
  label: "Tear down a GitHub agent",
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

    // The repo's webhook points at the router (or, before the router, at the service itself).
    const router = project.services.find((s) => s.name === ROUTER);
    const domains = await Promise.all(
      [router?.id, service.id].flatMap((id) => (id ? [railway.serviceDomain(project.id, project.environmentId, id)] : [])),
    );
    const urls = domains.filter(Boolean).map((d) => `https://${d}/webhook`);
    const hooks = await ghApi<Hook[]>("GET", `repos/${repo}/hooks`);
    for (const hook of hooks.filter((h) => urls.includes(h.config.url ?? ""))) {
      await ghApi("DELETE", `repos/${repo}/hooks/${hook.id}`);
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
