import { type Change, type Context, ManagedResource } from "@achq/core";
import { async } from "@achq/utils/async";
import { GitHub } from "@achq/utils/gh";
import { BUILDS_GITHUB_APP, FLOW_POLL_INTERVAL_MS, FLOW_TIMEOUT_MS } from "./constants.ts";

type Props = { owner: string };
type State = { installed: boolean };

const GITHUB_API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";

/** Your gh login, at GITHUB_API_URL if that's set (tests point it at a fake). */
const github = (ctx: Context) => GitHub.connect({ token: GitHub.cliToken(ctx.env), baseUrl: ctx.env.GITHUB_API_URL || GITHUB_API });

const installed = async (ctx: Context, owner: string) =>
  (await github(ctx).userInstallations()).some((i) => i.app_slug === BUILDS_GITHUB_APP && GitHub.sameLogin(i.account.login, owner));

/**
 * Cloudflare's GitHub App, installed on an owner the deployer serves:
 * Workers Builds clones repos with it. achq can't install it, so it opens
 * GitHub's install page and waits until it's there. Read with your gh login.
 */
export class BuildsGitHubApp extends ManagedResource<Props, State, {}, "install"> {
  readonly kind = "cloudflare-github-app";

  async read({ owner }: Props, ctx: Context) {
    return { installed: await installed(ctx, owner) };
  }

  diff(_: Props, current: State): "install"[] {
    return current.installed ? [] : ["install"];
  }

  describe(_: "install", { owner }: Props): Change {
    return { op: "+", target: BUILDS_GITHUB_APP, what: "installation", detail: `on ${owner}, opens GitHub to install it` };
  }

  planned() {
    return {};
  }

  async apply({ owner }: Props, _current: State, _changes: "install"[], ctx: Context) {
    if (!ctx.open) throw new Error(`Installing ${BUILDS_GITHUB_APP} on ${owner} opens your browser, which only the CLI can do`);
    const url = `${ctx.env.GITHUB_WEB_URL || GITHUB_WEB}/apps/${BUILDS_GITHUB_APP}/installations/new`;
    ctx.log(`  Workers Builds clones repos with Cloudflare's GitHub App. Install it on ${owner}, on all repos or the ones achq will serve, at ${url}`);
    await ctx.open(url, `install ${BUILDS_GITHUB_APP} on ${owner}`);
    const done = await async.pollUntil(() => installed(ctx, owner), Boolean, { intervalMs: FLOW_POLL_INTERVAL_MS, timeoutMs: FLOW_TIMEOUT_MS, sleep: ctx.sleep });
    if (!done) throw new Error(`${BUILDS_GITHUB_APP} isn't installed on ${owner} after ${FLOW_TIMEOUT_MS / 60_000} minutes`);
    return {};
  }
}
