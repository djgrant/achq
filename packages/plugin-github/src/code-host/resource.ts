// A repo set up for achq on GitHub: the config's App installed on it. What
// `achq install` and `uninstall` plan. Made by the code host provider from a
// repo's config, not declared, and read and changed as your gh login, not as
// the App.
import { type Change, type Context, ManagedResource } from "@achq/core";
import { type GitHubClient, githubUrls } from "../lib/client.ts";
import { covers } from "../lib/permissions.ts";
import { userGitHub } from "../lib/user.ts";

export type AppSettings = { events: string[]; permissions: Record<string, string> };

export type CodeHostProps = {
  slug: string;
  /** `owner/name`. */
  repo: string;
  /** Wanted: true to install it on the repo, false to remove it. */
  installed: boolean;
  /** What the repo's config needs the App to send and allow. */
  needs: AppSettings;
};

export type CodeHostState = {
  /** The live App, "private" when GitHub won't show it (a 404, even to its owner). Only read when installing. */
  app?: AppSettings | "private";
  /** The App's installation on the repo's owner, among those your login can see. */
  installation?: { id: number; owner: string; all: boolean; settings: string };
  /** Whether the repo is in it. */
  present: boolean;
};

/** "open": the App has no installation on the owner yet, so you install it on GitHub. */
export type CodeHostChange = "add" | "open" | "remove";

type InstallationRow = { id: number; app_slug: string; account: { login: string; type: string }; repository_selection: "all" | "selected" };

const ownerOf = (repo: string) => repo.split("/")[0]!;

const installationSettings = (i: InstallationRow, web: string) =>
  i.account.type === "Organization" ? `${web}/organizations/${i.account.login}/settings/installations/${i.id}` : `${web}/settings/installations/${i.id}`;

const liveApp = async (gh: GitHubClient, slug: string): Promise<AppSettings | "private"> => {
  const res = await gh.raw("GET", `/apps/${slug}`);
  if (res.status === 404) return "private";
  if (!res.ok) throw new Error(`GET /apps/${slug}: ${res.status} ${await res.text()}`);
  const { events, permissions } = (await res.json()) as AppSettings;
  return { events, permissions };
};

/** What the live App lacks of what the config needs. */
const missing = (app: AppSettings, needs: AppSettings) => [
  ...needs.events.filter((e) => !app.events.includes(e)).map((e) => `the ${e} event`),
  ...Object.entries(needs.permissions)
    .filter(([name, level]) => !covers(app.permissions[name], level))
    .map(([name, level]) => `${name}: ${level}`),
];

/** Named after the App, so the CLI can say what's installed. */
export class CodeHost extends ManagedResource<CodeHostProps, CodeHostState, {}, CodeHostChange> {
  readonly kind = "github-code-host";

  constructor(props: CodeHostProps) {
    super(props.slug, props, { declared: false });
  }

  async read({ slug, repo, installed }: CodeHostProps, ctx: Context): Promise<CodeHostState> {
    const { api, web } = githubUrls(ctx.env);
    const gh = userGitHub(api, ctx.env);
    const app = installed ? await liveApp(gh, slug) : undefined;
    const all = await gh.paginate<InstallationRow>("/user/installations", (page) => page.installations);
    const row = all.find((i) => i.app_slug === slug && i.account.login.toLowerCase() === ownerOf(repo).toLowerCase());
    if (!row) return { app, present: false };
    const installation = { id: row.id, owner: row.account.login, all: row.repository_selection === "all", settings: installationSettings(row, web) };
    if (installation.all) return { app, installation, present: true };
    const repos = await gh.paginate<{ full_name: string }>(`/user/installations/${row.id}/repositories`, (page) => page.repositories);
    return { app, installation, present: repos.some((r) => r.full_name.toLowerCase() === repo.toLowerCase()) };
  }

  /** Throws for what can't be applied: an App lacking what the config needs, or removing one repo from an install on all of them. */
  diff({ slug, repo, installed, needs }: CodeHostProps, current: CodeHostState): CodeHostChange[] {
    if (installed) {
      const lacks = current.app && current.app !== "private" ? missing(current.app, needs) : [];
      if (lacks.length) throw new Error(`${slug} doesn't have what ${repo}'s config needs: ${lacks.join(", ")}`);
      if (current.present) return [];
      return [current.installation ? "add" : "open"];
    }
    if (!current.present) return [];
    if (current.installation!.all) {
      throw new Error(`${slug} is installed on all of ${current.installation!.owner}'s repos; choose repos at ${current.installation!.settings}`);
    }
    return ["remove"];
  }

  describe(change: CodeHostChange, { slug, repo }: CodeHostProps): Change {
    if (change === "open") return { op: "+", target: `${slug} on ${ownerOf(repo)}`, detail: "opens GitHub to install it" };
    return { op: change === "add" ? "+" : "-", target: `${slug} on ${repo}` };
  }

  planned() {
    return {};
  }

  async apply({ slug, repo }: CodeHostProps, current: CodeHostState, [change]: CodeHostChange[], ctx: Context) {
    const { api, web } = githubUrls(ctx.env);
    if (change === "open") {
      const url = `${web}/apps/${slug}/installations/new`;
      if (!ctx.open) throw new Error(`Installing ${slug} on ${ownerOf(repo)} opens your browser, which only the CLI can do`);
      ctx.log(`${slug} isn't installed on ${ownerOf(repo)} yet. Install it on ${repo} at ${url}`);
      await ctx.open(url, `install ${slug} on ${ownerOf(repo)}`);
      return {};
    }
    const gh = userGitHub(api, ctx.env);
    const { id } = await gh.request<{ id: number }>("GET", `/repos/${repo}`);
    // The same endpoint serves user and organisation installations; it needs admin on the repo.
    await gh.request(change === "add" ? "PUT" : "DELETE", `/user/installations/${current.installation!.id}/repositories/${id}`);
    if (change === "remove") ctx.log(`${repo}'s containers sleep, and are kept until \`achq up --prune\`.`);
    return {};
  }

  check({ slug, installed }: CodeHostProps, current: CodeHostState) {
    return installed && current.app === "private" ? [`${slug} is private, so GitHub won't show its settings; skipping the App check`] : [];
  }
}
