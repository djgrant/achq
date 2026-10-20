// A repo set up for achq on GitHub: the config's App installed on it. What
// `achq install` and `uninstall` plan. Made by the code host provider from a
// repo's config, not declared, and read and changed as your gh login, not as
// the App.
import { type Change, type Context, ManagedResource } from "@achq/core";
import { type AppSettings, type GitHub, sameLogin, sameRepo, splitRepo, type UserInstallation } from "@achq/utils/gh";
import { githubUrls } from "../lib/client.ts";
import { covers } from "../lib/permissions.ts";
import { userGitHub } from "../lib/user.ts";

export type { AppSettings };

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

const ownerOf = (repo: string) => splitRepo(repo).owner;

/** Where you choose an installation's repos on GitHub. */
const installationSettings = ({ id, account }: UserInstallation, web: string) =>
  account.type === "Organization" ? `${web}/organizations/${account.login}/settings/installations/${id}` : `${web}/settings/installations/${id}`;

/** The App's settings as GitHub shows them, or "private" when it won't. */
const liveApp = async (gh: GitHub, slug: string): Promise<AppSettings | "private"> => {
  const app = await gh.publicApp(slug);
  return app ? { events: app.events, permissions: app.permissions } : "private";
};

/** The App's installation on `owner`, among those your login can see. */
const installationOn = async (gh: GitHub, slug: string, owner: string) =>
  (await gh.userInstallations()).find((i) => i.app_slug === slug && sameLogin(i.account.login, owner));

/** Whether a selected-repos installation includes `repo`. */
const selects = async (gh: GitHub, installationId: number, repo: string) =>
  (await gh.userInstallationRepos(installationId)).some((r) => sameRepo(r.full_name, repo));

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
    const found = await installationOn(gh, slug, ownerOf(repo));
    if (!found) return { app, present: false };
    const installation = { id: found.id, owner: found.account.login, all: found.repository_selection === "all", settings: installationSettings(found, web) };
    if (installation.all) return { app, installation, present: true };
    return { app, installation, present: await selects(gh, found.id, repo) };
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

  async apply(props: CodeHostProps, current: CodeHostState, [change]: CodeHostChange[], ctx: Context) {
    if (change === "open") await openInstallPage(props, ctx);
    else await changeInstallationRepos(props, current.installation!.id, change!, ctx);
    return {};
  }

  check({ slug, installed }: CodeHostProps, current: CodeHostState) {
    return installed && current.app === "private" ? [`${slug} is private, so GitHub won't show its settings; skipping the App check`] : [];
  }
}

/** Opens GitHub's page for installing the App on the repo's owner: achq can't create an installation. */
const openInstallPage = async ({ slug, repo }: CodeHostProps, ctx: Context) => {
  const url = `${githubUrls(ctx.env).web}/apps/${slug}/installations/new`;
  if (!ctx.open) throw new Error(`Installing ${slug} on ${ownerOf(repo)} opens your browser, which only the CLI can do`);
  ctx.log(`${slug} isn't installed on ${ownerOf(repo)} yet. Install it on ${repo} at ${url}`);
  await ctx.open(url, `install ${slug} on ${ownerOf(repo)}`);
};

/** Adds the repo to the installation, or removes it. Needs admin on the repo. */
const changeInstallationRepos = async ({ repo }: CodeHostProps, installationId: number, change: "add" | "remove", ctx: Context) => {
  const gh = userGitHub(githubUrls(ctx.env).api, ctx.env);
  const { id: repoId } = await gh.repo(repo).info();
  if (change === "add") return gh.addToInstallation(installationId, repoId);
  await gh.removeFromInstallation(installationId, repoId);
  ctx.log(`${repo}'s containers sleep, and are kept until \`achq up --prune\`.`);
};
