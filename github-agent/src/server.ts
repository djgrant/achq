import type { Config } from "./config.ts";
import { GitHub } from "./github.ts";
import { configureGit } from "./repo.ts";
import { reportInterrupted, Runner } from "./run.ts";
import { jobFrom, verifySignature } from "./webhook.ts";

/**
 * The agent's HTTP server. GitHub calls POST /webhook for every issue comment
 * on the repo (the repo webhook `ak agent add` creates), and Railway's
 * healthcheck calls GET /.
 */
export const serve = async (cfg: Config) => {
  const gh = new GitHub(cfg.appId, cfg.privateKey, cfg.repo, cfg.paths.github);
  await gh.connect();
  await configureGit(gh.bot, gh.tokenFile);
  setInterval(() => gh.installationToken().catch((e) => console.error("token refresh failed", e)), 5 * 60_000);
  await reportInterrupted(cfg, gh);

  const runner = new Runner(cfg, gh);

  Bun.serve({
    port: cfg.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/") return new Response("ok");
      if (req.method !== "POST" || url.pathname !== "/webhook") return new Response("not found", { status: 404 });
      const body = await req.text();
      if (!verifySignature(cfg.webhookSecret, body, req.headers.get("x-hub-signature-256"))) {
        return new Response("bad signature", { status: 401 });
      }
      const job = jobFrom(req.headers.get("x-github-event"), JSON.parse(body), cfg);
      if ("skip" in job) return new Response(`skipped: ${job.skip}`);
      console.log(`[issue-${job.issue}] queued comment ${job.commentId} from @${job.author}`);
      runner.enqueue(job);
      return new Response("queued", { status: 202 });
    },
  });

  console.log(`github-agent for ${cfg.repo} as ${gh.bot.login}, listening on :${cfg.port}`);
};
