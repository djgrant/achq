import { $ } from "bun";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO } from "../config/paths.ts";
import { appJwt } from "../../github-agent/src/github.ts";
import { loadEnv } from "./env.ts";

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

/** Each repo's webhook secret, derived from one key so re-running `add` is idempotent. */
export const webhookSecret = (key: string, repo: string) => createHmac("sha256", key).update(repo).digest("hex");

/** A repo's service name, from owner and repo so same-named repos don't collide. */
export const serviceName = (repo: string) => repo.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

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
    project.services.map(async (s) => {
      const { variables } = await railway.gql<{ variables: Record<string, string> }>(
        `query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
          variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
        }`,
        { projectId: project.id, environmentId: project.environmentId, serviceId: s.id },
      );
      return variables.AGENT_REPO;
    }),
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

  async serviceDomain(projectId: string, environmentId: string, serviceId: string) {
    const { domains } = await this.gql<{ domains: { serviceDomains: { domain: string }[] } }>(
      `query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
        domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { domain } }
      }`,
      { projectId, environmentId, serviceId },
    );
    return domains.serviceDomains[0]?.domain;
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
