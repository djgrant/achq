// `achq install` and `uninstall` act with your gh login, not as the App.
import type { GitHubClient } from "../api/client.ts";
import { GITHUB_WEB } from "../constants.ts";

type InstallationRow = { id: number; app_slug: string; account: { login: string; type: string }; repository_selection: "all" | "selected" };

/** The App's installation on `owner`, among those your login can see. */
export const findInstallation = async (gh: GitHubClient, slug: string, owner: string) => {
  const all = await gh.paginate<InstallationRow>("/user/installations", (page) => page.installations);
  return all.find((i) => i.app_slug === slug && i.account.login.toLowerCase() === owner.toLowerCase());
};

const installationSettings = (i: InstallationRow) =>
  i.account.type === "Organization" ? `${GITHUB_WEB}/organizations/${i.account.login}/settings/installations/${i.id}` : `${GITHUB_WEB}/settings/installations/${i.id}`;

export type InstallResult =
  | { kind: "installed"; installation: number }
  | { kind: "already"; installation: number; all: boolean }
  | { kind: "open"; url: string };

/** Adds the repo to the App's installation on its owner, or says where to install the App. */
export const installRepo = async (gh: GitHubClient, slug: string, repo: string): Promise<InstallResult> => {
  const owner = repo.split("/")[0];
  const installation = await findInstallation(gh, slug, owner);
  if (!installation) return { kind: "open", url: `${GITHUB_WEB}/apps/${slug}/installations/new` };
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
