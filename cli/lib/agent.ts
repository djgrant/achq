import { $ } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO } from "../config/paths.ts";
import { appJwt } from "../../github-agent/src/github.ts";
import { serviceName, webhookSecret } from "../../github-agent/src/router.ts";
import { loadEnv } from "./env.ts";

export { serviceName, webhookSecret };

/** App credentials, tokens and Railway IDs for `ak agent`, gitignored. */
export const AGENT_SECRETS_FILE = path.join(REPO, "github-agent/secrets.env");

export const agentEnv = () => loadEnv(AGENT_SECRETS_FILE);

/** A secret by name. Values like op://vault/item/field are read from 1Password. */
export const need = (env: Record<string, string>, name: string, hint: string): string => {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name} in ${AGENT_SECRETS_FILE} or the environment. ${hint}`);
  if (!value.startsWith("op://")) return value;
  const read = Bun.spawnSync(["op", "read", value], { stderr: "pipe" });
  if (read.exitCode !== 0) throw new Error(`Couldn't read ${name} from 1Password: ${read.stderr.toString().trim()}`);
  return (env[name] = read.stdout.toString().trim());
};

/** Sets KEY="value" in the secrets file. parseEnv turns the escaped newlines back. */
export const saveSecret = (name: string, value: string) => {
  const line = `${name}="${value.replace(/\n/g, "\\n")}"`;
  const lines = fs.existsSync(AGENT_SECRETS_FILE)
    ? fs.readFileSync(AGENT_SECRETS_FILE, "utf8").split("\n").filter(Boolean)
    : [];
  const at = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  fs.writeFileSync(AGENT_SECRETS_FILE, `${lines.join("\n")}\n`, { mode: 0o600 });
};


/** The service for `owner/repo`, or for a bare repo name that only one service ends in. */
export const findService = <S extends { name: string }>(services: S[], repo: string): S => {
  const matches = repo.includes("/")
    ? services.filter((s) => s.name === serviceName(repo))
    : services.filter((s) => s.name.endsWith(`-${serviceName(repo)}`));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`No agent deployed for ${repo}`);
  throw new Error(`${repo} matches several services (${matches.map((s) => s.name).join(", ")}). Use owner/repo.`);
};

/** The repos with a deployed agent, read from each service's AGENT_REPO, for picking one interactively. */
export const deployedRepos = async () => {
  const env = agentEnv();
  const railway = new Railway(need(env, "RAILWAY_API_TOKEN", ""));
  const project = await railway.project(need(env, "RAILWAY_PROJECT_ID", "Nothing has been deployed."));
  const repos = await Promise.all(
    project.services.map(async (s) => (await railway.variables(project.id, project.environmentId, s.id)).AGENT_REPO),
  );
  return repos.filter(Boolean).sort();
};

/** Interactive prompts skip the arg's schema, so commands that need the owner check again. */
export const ownerRepo = (repo: string) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Expected owner/repo, got ${repo}`);
  return repo;
};

/** The App's installation on a repo, or undefined if it isn't installed there. */
export const appInstallation = async (env: Record<string, string>, repo: string) => {
  const jwt = appJwt(need(env, "GITHUB_APP_ID", "Run `ak agent app`."), need(env, "GITHUB_APP_PRIVATE_KEY", ""));
  const res = await fetch(`https://api.github.com/repos/${repo}/installation`, {
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "agentkit" },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: number };
};

/** `gh api`, with an optional JSON body. */
export const ghApi = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
  const input = body === undefined ? "" : JSON.stringify(body);
  const out = body === undefined
    ? await $`gh api -X ${method} ${route}`.quiet().text()
    : await $`gh api -X ${method} ${route} --input - < ${new Response(input)}`.quiet().text();
  return (out.trim() ? JSON.parse(out) : undefined) as T;
};

export type Hook = { id: number; config: { url?: string } };

/**
 * `railway ssh` into a repo's agent container, interactively or running
 * `command`. The container starts as root; `github-agent` switches to the agent user.
 */
export const railwaySsh = async (repo: string, command: string[]) => {
  if (!Bun.which("railway")) throw new Error("Needs the Railway CLI: brew install railway");
  const env = agentEnv();
  const token = need(env, "RAILWAY_API_TOKEN", "");
  const project = await new Railway(token).project(need(env, "RAILWAY_PROJECT_ID", "Nothing has been deployed."));
  const service = findService(project.services, repo).name;
  const args = ["ssh", "--project", project.id, "--environment", project.environmentId, "--service", service];
  const proc = Bun.spawn(["railway", ...args, ...(command.length ? ["--", ...command] : [])], {
    env: { ...process.env, RAILWAY_API_TOKEN: token },
    stdio: ["inherit", "inherit", "inherit"],
  });
  return proc.exited;
};

export const ROUTER = "agentkit-router";
const ROUTER_PORT = 8080;
// The stock Bun image runs router.ts straight from agentkit at AGENTKIT_REF, so the router needs no build.
const ROUTER_START = `bun -e 'const res = await fetch(\`https://raw.githubusercontent.com/djgrant/agentkit/\${process.env.AGENTKIT_REF}/github-agent/src/router.ts\`); if (!res.ok) throw new Error(\`router.ts: \${res.status}\`); await Bun.write("/tmp/router.ts", res); (await import("/tmp/router.ts")).start()'`;

type Project = Awaited<ReturnType<Railway["project"]>>;

/**
 * Creates the router every repo's webhook goes to, or redeploys it when its
 * agentkit ref or key changed. Returns its public domain.
 */
export const ensureRouter = async (railway: Railway, project: Project, vars: { AGENTKIT_REF: string; AGENT_WEBHOOK_KEY: string }) => {
  const { id: projectId, environmentId } = project;
  let service: { id: string } | undefined = project.services.find((s) => s.name === ROUTER);
  let deploy = !service;
  if (service) {
    const current = await railway.variables(projectId, environmentId, service.id);
    deploy = current.AGENTKIT_REF !== vars.AGENTKIT_REF || current.AGENT_WEBHOOK_KEY !== vars.AGENT_WEBHOOK_KEY;
  } else {
    ({ serviceCreate: service } = await railway.gql<{ serviceCreate: { id: string } }>(
      `mutation ($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
      { input: { projectId, environmentId, name: ROUTER } },
    ));
  }
  const serviceId = service.id;
  if (deploy) {
    await railway.gql(
      `mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }`,
      { serviceId, environmentId, input: { source: { image: "oven/bun:1-slim" }, startCommand: ROUTER_START, healthcheckPath: "/" } },
    );
    await railway.gql(`mutation ($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`, {
      input: { projectId, environmentId, serviceId, variables: { ...vars, PORT: String(ROUTER_PORT) }, skipDeploys: true },
    });
    await railway.gql(
      `mutation ($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
      { serviceId, environmentId },
    );
  }
  let domain = await railway.serviceDomain(projectId, environmentId, serviceId);
  if (!domain) {
    ({ serviceDomainCreate: { domain } } = await railway.gql<{ serviceDomainCreate: { domain: string } }>(
      `mutation ($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
      { input: { environmentId, serviceId, targetPort: ROUTER_PORT } },
    ));
  }
  return { domain, deployed: deploy };
};

export class Railway {
  constructor(private token: string) {}

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length || !json.data) {
      throw new Error(`Railway: ${json.errors?.map((e) => e.message).join("; ") ?? res.status}`);
    }
    return json.data;
  }

  /** The token's only workspace; with several, RAILWAY_WORKSPACE_ID picks one. */
  async workspaceId() {
    const { apiToken } = await this.gql<{ apiToken: { workspaces: { id: string; name: string }[] } }>(
      `query { apiToken { workspaces { id name } } }`,
    );
    if (apiToken.workspaces.length === 1) return apiToken.workspaces[0].id;
    const list = apiToken.workspaces.map((w) => `${w.name}: ${w.id}`).join(", ");
    throw new Error(`Set RAILWAY_WORKSPACE_ID to one of your Railway workspaces: ${list}`);
  }

  async project(id: string) {
    const { project } = await this.gql<{ project: RailwayProject }>(
      `query ($id: String!) {
        project(id: $id) {
          id name
          environments(first: 1) { edges { node { id name } } }
          services { edges { node { id name deployments(first: 1) { edges { node { status createdAt } } } } } }
          volumes { edges { node { id name volumeInstances { edges { node { serviceId mountPath } } } } } }
        }
      }`,
      { id },
    );
    return {
      id: project.id,
      environmentId: project.environments.edges[0].node.id,
      services: project.services.edges.map((e) => ({
        id: e.node.id,
        name: e.node.name,
        deployment: e.node.deployments.edges[0]?.node as { status: string; createdAt: string } | undefined,
      })),
      volumes: project.volumes.edges.flatMap((e) =>
        e.node.volumeInstances.edges.map((i) => ({ id: e.node.id, serviceId: i.node.serviceId })),
      ),
    };
  }

  async serviceDomains(projectId: string, environmentId: string, serviceId: string) {
    const { domains } = await this.gql<{ domains: { serviceDomains: { id: string; domain: string }[] } }>(
      `query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
        domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { id domain } }
      }`,
      { projectId, environmentId, serviceId },
    );
    return domains.serviceDomains;
  }

  async serviceDomain(projectId: string, environmentId: string, serviceId: string) {
    return (await this.serviceDomains(projectId, environmentId, serviceId))[0]?.domain;
  }

  /**
   * Gives a service the private hostname `<dnsName>.railway.internal`. Railway
   * takes it from the service's name on its first deploy and keeps it through renames.
   */
  async privateHostname(environmentId: string, serviceId: string, dnsName: string) {
    const { privateNetworks } = await this.gql<{ privateNetworks: { publicId: string }[] }>(
      `query ($environmentId: String!) { privateNetworks(environmentId: $environmentId) { publicId } }`,
      { environmentId },
    );
    const privateNetworkId = privateNetworks[0].publicId;
    const { privateNetworkEndpoint: endpoint } = await this.gql<{ privateNetworkEndpoint: { publicId: string; dnsName: string } | null }>(
      `query ($environmentId: String!, $privateNetworkId: String!, $serviceId: String!) {
        privateNetworkEndpoint(environmentId: $environmentId, privateNetworkId: $privateNetworkId, serviceId: $serviceId) { publicId dnsName }
      }`,
      { environmentId, privateNetworkId, serviceId },
    );
    // A service that hasn't deployed yet has no hostname, and will get one from its name.
    if (!endpoint || endpoint.dnsName === dnsName) return false;
    await this.gql(
      `mutation ($id: String!, $dnsName: String!, $privateNetworkId: String!) {
        privateNetworkEndpointRename(id: $id, dnsName: $dnsName, privateNetworkId: $privateNetworkId)
      }`,
      { id: endpoint.publicId, dnsName, privateNetworkId },
    );
    return true;
  }

  async variables(projectId: string, environmentId: string, serviceId: string) {
    const { variables } = await this.gql<{ variables: Record<string, string> }>(
      `query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
        variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
      }`,
      { projectId, environmentId, serviceId },
    );
    return variables;
  }
}

type Edges<T> = { edges: { node: T }[] };
type RailwayProject = {
  id: string;
  name: string;
  environments: Edges<{ id: string; name: string }>;
  services: Edges<{ id: string; name: string; deployments: Edges<{ status: string; createdAt: string }> }>;
  volumes: Edges<{ id: string; name: string; volumeInstances: Edges<{ serviceId: string; mountPath: string }> }>;
};
