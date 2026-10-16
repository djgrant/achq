/**
 * The one public endpoint in front of every repo's agent. Repo services sleep
 * when idle and have no public domain, so GitHub sends each repo's webhook here.
 * The router forwards comments that mention the trigger to the repo's service
 * over Railway's private network, retrying while the service wakes. It also
 * wakes a service on request, for SSH.
 *
 * Self-contained, because Railway runs it as a single downloaded file.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Checks GitHub's X-Hub-Signature-256 header against the raw body. */
export const verifySignature = (secret: string, body: string, header: string | null): boolean => {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

/** Each repo's webhook secret, derived from one key so the router can check every repo's. */
export const webhookSecret = (key: string, repo: string) => createHmac("sha256", key).update(repo).digest("hex");

/** A repo's service name, from owner and repo so same-named repos don't collide. */
export const serviceName = (repo: string) => repo.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

/** Seconds between attempts while a sleeping service wakes: about five minutes in all. */
const DELAYS = [2, 4, 8, 15, 30, 30, 30, 30, 60, 60];

const FORWARDED = ["content-type", "x-github-event", "x-github-delivery", "x-hub-signature-256"];

type Options = {
  key: string;
  trigger: string;
  agentPort: number;
  forward?: (url: string, init: RequestInit) => Promise<Response>;
  delays?: number[];
};

export const createRouter = ({ key, trigger, agentPort, forward = fetch, delays = DELAYS }: Options) => {
  /** Requests `path` on the repo's service until it answers with anything but a 5xx. */
  const reach = async (repo: string, path: string, init: RequestInit) => {
    const url = `http://${serviceName(repo)}.railway.internal:${agentPort}${path}`;
    let last = "";
    for (const delay of [0, ...delays]) {
      await Bun.sleep(delay * 1000);
      try {
        const res = await forward(url, init);
        if (res.status < 500) return { ok: true, detail: `${res.status} ${await res.text()}` };
        last = `${res.status}`;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    return { ok: false, detail: `gave up after ${delays.length + 1} attempts (${last})` };
  };

  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/") return new Response("ok");
    if (req.method !== "POST" || (pathname !== "/webhook" && pathname !== "/wake")) {
      return new Response("not found", { status: 404 });
    }
    const body = await req.text();
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("bad body", { status: 400 });
    }
    const repo: string | undefined = payload.repository?.full_name;
    if (!repo || !verifySignature(webhookSecret(key, repo), body, req.headers.get("x-hub-signature-256"))) {
      return new Response("bad signature", { status: 401 });
    }
    // `ak agent ssh` signs a wake request the way GitHub signs a webhook, and waits for the service.
    if (pathname === "/wake") {
      const { ok, detail } = await reach(repo, "/", { method: "GET" });
      console.log(`${repo}: wake ${detail}`);
      return new Response(ok ? "awake" : detail, { status: ok ? 200 : 504 });
    }
    // Only wake a service for something it would act on. It checks everything else.
    const event = req.headers.get("x-github-event");
    if (event !== "issue_comment" || payload.action !== "created" || !payload.comment?.body?.includes(trigger)) {
      return new Response("skipped");
    }
    const headers = Object.fromEntries(FORWARDED.flatMap((h) => (req.headers.has(h) ? [[h, req.headers.get(h)!]] : [])));
    // Answer GitHub now; it gives up after ten seconds and a waking service can take longer.
    void reach(repo, "/webhook", { method: "POST", headers, body }).then(({ ok, detail }) =>
      (ok ? console.log : console.error)(`${repo}: ${detail}`),
    );
    return new Response("forwarding", { status: 202 });
  };
};

export const start = () => {
  const key = process.env.AGENT_WEBHOOK_KEY;
  if (!key) throw new Error("Missing AGENT_WEBHOOK_KEY");
  const port = Number(process.env.PORT ?? 8080);
  const fetch = createRouter({
    key,
    trigger: process.env.AGENT_TRIGGER ?? "@claude",
    agentPort: Number(process.env.AGENT_PORT ?? 3000),
  });
  Bun.serve({ port, hostname: "::", fetch });
  console.log(`agentkit router listening on :${port}`);
};

if (import.meta.main) start();
