// `achq install` and `uninstall`: the App a repo's config names, checked
// against the live App, installed on (or removed from) the repo with your gh
// login, then the deploy's outcome read from ACHQ_STATUS.
import type { Status } from "@achq/core";
import type { RepoPlan } from "@achq/core";
import type { GitHubClient } from "@achq/github/api";
import { readStatus } from "./gh.ts";

/** The one App slug the config's policies and selectors name. */
export const configApp = (plan: RepoPlan) => {
  const slugs = new Set<string>();
  for (const { policy } of plan.policies) if (policy.provider === "github" && typeof policy.app === "string") slugs.add(policy.app);
  const selectors = [...plan.workspaces.map((w) => w.threads), ...plan.triggers.map((t) => t.event)];
  for (const s of selectors) if (s.channel === "github" && typeof s.source === "string") slugs.add(s.source);
  if (slugs.size !== 1) {
    throw new Error(slugs.size ? `The config names several Apps (${[...slugs].join(", ")}); achq install needs exactly one` : "The config names no GitHub App");
  }
  return [...slugs][0];
};

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** The events and permissions the config needs from its App. */
export const configNeeds = (plan: RepoPlan, slug: string) => {
  // Pushes keep the deployment in line with the config.
  const events = new Set<string>(["push"]);
  for (const t of plan.triggers) if (t.event.channel === "github" && typeof t.event.event === "string") events.add(t.event.event);
  const permissions: Record<string, string> = { metadata: "read", actions_variables: "write" };
  const want = (name: string, level: string) => {
    if ((RANK[level] ?? 0) > (RANK[permissions[name]] ?? 0)) permissions[name] = level;
  };
  // Replies go on the thread as the App.
  if (plan.workspaces.some((w) => w.threads.channel === "github")) want("issues", "write");
  for (const { policy } of plan.policies) {
    if (policy.provider !== "github" || policy.app !== slug) continue;
    for (const [name, level] of Object.entries((policy.permissions ?? {}) as Record<string, string>)) want(name, level);
  }
  return { events: [...events].sort(), permissions };
};

export type AppCheck = { private: true } | { private: false; missing: string[] };

/** Compares the live App with what the config needs. A private App is a 404, even to its owner. */
export const checkApp = async (gh: GitHubClient, slug: string, plan: RepoPlan): Promise<AppCheck> => {
  const res = await gh.raw("GET", `/apps/${slug}`);
  if (res.status === 404) return { private: true };
  if (!res.ok) throw new Error(`GET /apps/${slug}: ${res.status} ${await res.text()}`);
  const app = (await res.json()) as { events: string[]; permissions: Record<string, string> };
  const needs = configNeeds(plan, slug);
  return {
    private: false,
    missing: [
      ...needs.events.filter((e) => !app.events.includes(e)).map((e) => `the ${e} event`),
      ...Object.entries(needs.permissions)
        .filter(([name, level]) => (RANK[app.permissions[name]] ?? 0) < RANK[level])
        .map(([name, level]) => `${name}: ${level}`),
    ],
  };
};

type InstallationRow = { id: number; app_slug: string; account: { login: string; type: string }; repository_selection: "all" | "selected" };

/** The App's installation on `owner`, among those your login can see. */
export const findInstallation = async (gh: GitHubClient, slug: string, owner: string) => {
  const all = await gh.paginate<InstallationRow>("/user/installations", (page) => page.installations);
  return all.find((i) => i.app_slug === slug && i.account.login.toLowerCase() === owner.toLowerCase());
};

const installationSettings = (i: InstallationRow) =>
  i.account.type === "Organization" ? `https://github.com/organizations/${i.account.login}/settings/installations/${i.id}` : `https://github.com/settings/installations/${i.id}`;

export type InstallResult =
  | { kind: "installed"; installation: number }
  | { kind: "already"; installation: number; all: boolean }
  | { kind: "open"; url: string };

/** Adds the repo to the App's installation on its owner, or says where to install the App. */
export const installRepo = async (gh: GitHubClient, slug: string, repo: string): Promise<InstallResult> => {
  const owner = repo.split("/")[0];
  const installation = await findInstallation(gh, slug, owner);
  if (!installation) return { kind: "open", url: `https://github.com/apps/${slug}/installations/new` };
  if (installation.repository_selection === "all") return { kind: "already", installation: installation.id, all: true };
  const repos = await gh.paginate<{ full_name: string }>(`/user/installations/${installation.id}/repositories`, (page) => page.repositories);
  if (repos.some((r) => r.full_name.toLowerCase() === repo.toLowerCase())) return { kind: "already", installation: installation.id, all: false };
  const { id } = await gh.request<{ id: number }>("GET", `/repos/${repo}`);
  // The same endpoint serves user and organisation installations; it needs admin on the repo.
  await gh.request("PUT", `/user/installations/${installation.id}/repositories/${id}`);
  return { kind: "installed", installation: installation.id };
};

/** Removes the repo from the App's installation. */
export const uninstallRepo = async (gh: GitHubClient, slug: string, repo: string) => {
  const installation = await findInstallation(gh, slug, repo.split("/")[0]);
  if (!installation) throw new Error(`${slug} isn't installed on ${repo.split("/")[0]}`);
  if (installation.repository_selection === "all") {
    throw new Error(`${slug} is installed on all of ${installation.account.login}'s repos; choose repos at ${installationSettings(installation)}`);
  }
  const { id } = await gh.request<{ id: number }>("GET", `/repos/${repo}`);
  await gh.request("DELETE", `/user/installations/${installation.id}/repositories/${id}`);
};

/** Polls ACHQ_STATUS until it shows a result newer than `since`, or times out. */
export const waitForStatus = async (
  gh: GitHubClient,
  repo: string,
  since: Date,
  options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<Status | undefined> => {
  const { timeoutMs = 180_000, intervalMs = 5000, sleep = Bun.sleep, now = Date.now } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = await readStatus(gh, repo);
    if (status && Date.parse(status.at) > since.getTime()) return status;
    if (now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
};

/** A status as one or two lines. */
export const formatStatus = (status: Status) => {
  const lines = [`${status.state} at ${status.at}${status.commit ? ` (${status.commit.slice(0, 7)})` : ""}${status.error ? `: ${status.error}` : ""}`];
  if (status.containers?.length) lines.push(`containers: ${status.containers.map((c) => c.name).join(", ")}`);
  for (const w of status.warnings ?? []) lines.push(`! ${w}`);
  return lines;
};
