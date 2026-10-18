import { ENV, type RouterAccess } from "@achq/core";
import { adminSecret } from "@achq/core/secrets";
import { signedFetch } from "@achq/core/signing";
import type { RailwayClient } from "@achq/railway/api";
import { hostServiceName, publicBase } from "@achq/railway/runtime";

/** The router's public URL and AGENT_WEBHOOK_KEY, read from Railway. */
export const routerAccess = async (railway: RailwayClient, projectName: string, routerName: string, workspaceId?: string): Promise<RouterAccess> => {
  const found = await railway.projectByName(projectName, workspaceId);
  if (!found) throw new Error(`No Railway project ${projectName}. Run \`achq up\`.`);
  const project = await railway.project(found.id);
  const name = hostServiceName(routerName);
  const service = project.services.find((s) => s.name === name);
  if (!service) throw new Error(`No ${name} in ${projectName}. Run \`achq up\`.`);
  const [vars, domains] = await Promise.all([railway.variables(project.id, project.environmentId, service.id), railway.domains(project.id, project.environmentId, service.id)]);
  const key = vars[ENV.key];
  if (!key || !domains[0]) throw new Error(`${name} isn't set up. Run \`achq up\`.`);
  return { base: publicBase(domains[0].domain), key };
};

/** An admin-signed request to the router. Throws on anything but 2xx. */
export const adminRequest = async <T>(router: RouterAccess, method: string, path: string, body?: unknown): Promise<T> => {
  const res = await signedFetch(adminSecret(router.key), router.base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Router ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};
