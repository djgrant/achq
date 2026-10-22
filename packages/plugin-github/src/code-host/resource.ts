import { type Change, type Context, ManagedResource, repoName } from "@achq/core";
import { type AppSettings, GitHub } from "@achq/utils/gh";
import { githubUrls } from "../lib/constants.ts";
import { lacking } from "../lib/permissions.ts";

export type { AppSettings };

export type CodeHostProps = {
  slug: string;
  repo: string;
  /** Wanted: true to install it on the repo, false to remove it. */
  installed: boolean;
  needs: AppSettings;
};

export type CodeHostState = {
  /** The live App, "private" when GitHub won't show it (a 404, even to its owner). Only read when installing. */
  app?: AppSettings | "private";
  /** The App's installation on the repo's owner, among those your login can see. */
  installation?: { id: number; owner: string; all: boolean; settings: string };
  present: boolean;
};

/** "open": the App has no installation on the owner yet, so you install it on GitHub. */
export type CodeHostChange = "add" | "open" | "remove";

const ownerOf = (repo: string) => repoName.split(repo).owner;

/** Named after the App, so the CLI can say what's installed. */
export class CodeHost extends ManagedResource<CodeHostProps, CodeHostState, {}, CodeHostChange> {
  readonly kind = "github-code-host";

  constructor(props: CodeHostProps) {
    super(props.slug, props, { declared: false });
  }

  async read({ slug, repo, installed }: CodeHostProps, ctx: Context): Promise<CodeHostState> {
    const { api, web } = githubUrls(ctx.env);
    const gh = GitHub.connect({ token: GitHub.cliToken(ctx.env), baseUrl: api });
    const app = installed ? ((await gh.publicApp(slug)) ?? "private") : undefined;
    const found = (await gh.userInstallations()).find((i) => i.app_slug === slug && GitHub.sameLogin(i.account.login, ownerOf(repo)));
    if (!found) return { app, present: false };
    const { id, account } = found;
    const settings = account.type === "Organization" ? `${web}/organizations/${account.login}/settings/installations/${id}` : `${web}/settings/installations/${id}`;
    const installation = { id, owner: account.login, all: found.repository_selection === "all", settings };
    if (installation.all) return { app, installation, present: true };
    return { app, installation, present: (await gh.userInstallationRepos(id)).some((r) => repoName.same(r.full_name, repo)) };
  }

  /** Throws for what can't be applied: an App lacking what the config needs, or removing one repo from an install on all of them. */
  diff({ slug, repo, installed, needs }: CodeHostProps, current: CodeHostState): CodeHostChange[] {
    if (installed) {
      if (current.app && current.app !== "private") {
        const lacks = lacking(current.app, needs);
        const missing = [...lacks.events.map((e) => `the ${e} event`), ...lacks.permissions.map(([name, level]) => `${name}: ${level}`)];
        if (missing.length) throw new Error(`${slug} doesn't have what ${repo}'s config needs: ${missing.join(", ")}`);
      }
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
    if (change === "open") return { op: "+", target: slug, what: "installation", detail: `on ${ownerOf(repo)}, opens GitHub to install it` };
    return { op: change === "add" ? "+" : "-", target: slug, what: "repo", detail: repo };
  }

  planned() {
    return {};
  }

  async apply({ slug, repo }: CodeHostProps, current: CodeHostState, [change]: CodeHostChange[], ctx: Context) {
    const { api, web } = githubUrls(ctx.env);
    if (change === "open") {
      // achq can't create an installation.
      const url = `${web}/apps/${slug}/installations/new`;
      if (!ctx.open) throw new Error(`Installing ${slug} on ${ownerOf(repo)} opens your browser, which only the CLI can do`);
      ctx.log(`${slug} isn't installed on ${ownerOf(repo)} yet. Install it on ${repo} at ${url}`);
      await ctx.open(url, `install ${slug} on ${ownerOf(repo)}`);
      return {};
    }
    // Adding or removing a repo needs admin on it.
    const gh = GitHub.connect({ token: GitHub.cliToken(ctx.env), baseUrl: api });
    const { id: repoId } = await gh.repo(repo).info();
    if (change === "add") {
      await gh.addToInstallation(current.installation!.id, repoId);
    } else {
      await gh.removeFromInstallation(current.installation!.id, repoId);
      ctx.log(`${repo}'s containers sleep, and are kept until \`achq infra up --prune\`.`);
    }
    return {};
  }

  check({ slug, installed }: CodeHostProps, current: CodeHostState) {
    return installed && current.app === "private" ? [`${slug} is private, so GitHub won't show its settings; skipping the App check`] : [];
  }
}
