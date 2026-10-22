import { type Change, type Context, ManagedResource, type RepoInstallation, repoName, STATUS_VARIABLE } from "@achq/core";
import { async } from "@achq/utils/async";
import { type AppSettings, GitHub } from "@achq/utils/gh";
import { FLOW_POLL_INTERVAL_MS, FLOW_TIMEOUT_MS, githubUrls } from "../lib/constants.ts";
import { lacking } from "../lib/permissions.ts";

export type { AppSettings };

export type CodeHostProps = {
  slug: string;
  repo: string;
  /** Wanted: true to install it on the repo, false to remove it. */
  installed: boolean;
  needs: AppSettings;
};

/**
 * The App's installation on the repo, as the router that serves it says: only
 * the App's key can tell, and your gh login can't list installations. Undefined
 * when there's no router to ask: the repo has no ACHQ_STATUS naming one yet.
 */
export type AskRouter = (repo: string, slug: string) => Promise<RepoInstallation | undefined>;

export type CodeHostState = {
  /** The live App, "private" when GitHub won't show it (a 404, even to its owner). Only read when installing. */
  app?: AppSettings | "private";
  installation?: RepoInstallation;
};

/** Both are made on GitHub, in your browser: adding a repo to an installation, or making one, and removing it. */
export type CodeHostChange = "add" | "remove";

const ownerOf = (repo: string) => repoName.split(repo).owner;

/** Named after the App, so the CLI can say what's installed. */
export class CodeHost extends ManagedResource<CodeHostProps, CodeHostState, {}, CodeHostChange> {
  readonly kind = "github-code-host";

  constructor(
    props: CodeHostProps,
    private readonly ask: AskRouter,
  ) {
    super(props.slug, props, { declared: false });
  }

  async read({ slug, repo, installed }: CodeHostProps, ctx: Context): Promise<CodeHostState> {
    const gh = GitHub.connect({ token: GitHub.cliToken(ctx.env), baseUrl: githubUrls(ctx.env).api });
    const app = installed ? ((await gh.publicApp(slug)) ?? "private") : undefined;
    return { app, installation: await this.ask(repo, slug) };
  }

  /** Throws for what can't be applied: an App lacking what the config needs, or removing it where no router can say whether it's there. */
  diff({ slug, repo, installed, needs }: CodeHostProps, current: CodeHostState): CodeHostChange[] {
    if (installed) {
      if (current.app && current.app !== "private") {
        const lacks = lacking(current.app, needs);
        const missing = [...lacks.events.map((e) => `the ${e} event`), ...lacks.permissions.map(([name, level]) => `${name}: ${level}`)];
        if (missing.length) throw new Error(`${slug} doesn't have what ${repo}'s config needs: ${missing.join(", ")}`);
      }
      // Without a router to ask, it's never been deployed: install it.
      return current.installation?.installed ? [] : ["add"];
    }
    if (!current.installation) {
      throw new Error(`achq can't tell whether ${slug} is installed on ${repo}: it has no ${STATUS_VARIABLE} naming its router yet. Remove it from ${slug}'s installation in ${ownerOf(repo)}'s settings on GitHub`);
    }
    return current.installation.installed ? ["remove"] : [];
  }

  describe(change: CodeHostChange, { slug, repo }: CodeHostProps): Change {
    return change === "add" ? { op: "+", target: slug, what: "repo", detail: `${repo}, opens GitHub to install it` } : { op: "-", target: slug, what: "repo", detail: `${repo}, opens GitHub to remove it` };
  }

  planned() {
    return {};
  }

  /**
   * Opens GitHub where you make the change: gh's token can't add a repo to an
   * installation or remove one (GitHub takes only a GitHub App's user token, a
   * fine-grained token or, for removing, a classic one).
   */
  async apply({ slug, repo }: CodeHostProps, current: CodeHostState, [change]: CodeHostChange[], ctx: Context) {
    const what = change === "add" ? `install ${slug} on ${repo}` : `remove ${repo} from ${slug}'s installation`;
    if (!ctx.open) throw new Error(`To ${what}, achq opens your browser, which only the CLI can do`);
    if (change === "add") {
      // The App's page installs it, or, on an owner it's installed on, goes to the installation, where you add the repo.
      const url = current.installation?.url ?? `${githubUrls(ctx.env).web}/apps/${slug}/installations/new`;
      ctx.log(`Install ${slug} on ${repo} at ${url}: on ${ownerOf(repo)}, with ${repo} among its repos.`);
      await ctx.open(url, what);
      return {};
    }
    const { url } = current.installation!;
    ctx.log(`Remove ${repo} from ${slug}'s installation at ${url}: under "Repository access", unselect it (on all repos, choose "Only select repositories" without it).`);
    await ctx.open(url, what);
    const removed = await async.pollUntil(() => this.ask(repo, slug), (found) => found?.installed === false, { intervalMs: FLOW_POLL_INTERVAL_MS, timeoutMs: FLOW_TIMEOUT_MS, sleep: ctx.sleep });
    if (!removed) throw new Error(`${slug} is still installed on ${repo} after ${FLOW_TIMEOUT_MS / 60_000} minutes`);
    ctx.log(`${repo}'s containers sleep, and are kept until \`achq infra up --prune\`.`);
    return {};
  }

  check({ slug, installed }: CodeHostProps, current: CodeHostState) {
    return installed && current.app === "private" ? [`${slug} is private, so GitHub won't show its settings; skipping the App check`] : [];
  }
}
