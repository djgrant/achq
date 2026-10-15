import { defineCommand } from "@pokit/core";
import { agentEnv, need, Railway } from "../lib/agent.ts";

export const command = defineCommand({
  label: "List deployed GitHub agents",
  examples: ["ak agent status"],
  run: async (r) => {
    const env = agentEnv();
    const railway = new Railway(need(env, "RAILWAY_API_TOKEN", ""));
    const project = await railway.project(need(env, "RAILWAY_PROJECT_ID", "Nothing has been deployed."));
    const rows = await Promise.all(
      project.services.map(async (s) => {
        const domain = await railway.serviceDomain(project.id, project.environmentId, s.id);
        return `| ${s.name} | ${s.deployment?.status ?? "—"} | ${s.deployment?.createdAt ?? "—"} | ${domain ?? "—"} |`;
      }),
    );
    r.reporter.markdown(["| Service | Deployment | Deployed | Domain |", "| --- | --- | --- | --- |", ...rows].join("\n"));
  },
});
