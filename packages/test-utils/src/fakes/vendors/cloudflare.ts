import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BuildToken, RepoConnection, Trigger, TriggerSettings } from "@achq/utils/cloudflare";
import { fakeBin } from "../../helpers/fake-bin.ts";

type FakeWorker = {
  id: string;
  name: string;
  /** Its module, as last uploaded through the API or deployed. */
  source: string;
  secrets: Record<string, string>;
  versions: { id: string; number: number; containers?: { class_name: string; images: Record<string, string> }[] }[];
  /** What Wrangler last deployed: its config. */
  config?: any;
};

/** As Workers Builds keeps it: what it answers with, and the Worker it builds and its variables. */
type FakeTrigger = Trigger & { external_script_id: string; variables: Record<string, { value: string; is_secret: boolean }> };

type FakeBuild = { build_uuid: string; trigger: string; branch: string; status: string; build_outcome: string | null; log: string[]; version?: string };

export type FakeCloudflare = {
  url: string;
  accountId: string;
  workers: Map<string, FakeWorker>;
  namespaces: Map<string, { title: string; values: Map<string, string> }>;
  buckets: Map<string, Map<string, string>>;
  tokens: BuildToken[];
  connections: (RepoConnection & { repo_connection_uuid: string })[];
  triggers: Map<string, FakeTrigger>;
  builds: Map<string, FakeBuild>;
  applications: { id: string; name: string }[];
  /** `METHOD /path` of each request that changes something, without the account prefix. */
  mutations: string[];
  /** Every request: `METHOD /path`, without the account prefix, and the token it carried. */
  requests: { call: string; token: string }[];
  /** API tokens Cloudflare takes, by their secret: each one's id. `cf-token` is a user token that can do all achq does. */
  apiTokens: Map<string, string>;
  /** What Wrangler's OAuth sign-in gives `wrangler auth token`: it reaches the account, but not Workers Builds or `/user/tokens/verify`. */
  oauthToken: string;
  /** Makes registering an API token as a Builds token fail, as it might. */
  registerFails: boolean;
  /** Repos (`owner/name`) Cloudflare's GitHub App isn't installed on: connecting one fails as Workers Builds does. */
  unseen: Set<string>;
  /** How the next build ends, and what its log says. */
  nextBuild: { outcome: string; log: string[]; deploysVersion: boolean };
  /** A namespace's values, by title. */
  kv(title: string): Map<string, string> | undefined;
  /** Each Worker the fake Wrangler deployed, and how it was signed in: with CLOUDFLARE_API_TOKEN, or its own OAuth sign-in. */
  wranglerDeploys: { name: string; auth: string }[];
  /** What the fake Wrangler sends, as Wrangler's deploy would. */
  wranglerDeploy(config: any, secrets: Record<string, string>): void;
  stop(): void;
};

const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
const fail = (status: number, message: string, code = status) => Response.json({ success: false, errors: [{ code, message }], result: null }, { status });

/** Cloudflare's API, for one account, as the plugin calls it. `subdomain` is the account's workers.dev subdomain, if it has one. */
export const startFakeCloudflare = (seed: { accountId?: string; subdomain?: string; tokens?: BuildToken[]; otherAccounts?: string[] } = {}) => {
  let next = 1;
  const id = (prefix: string) => `${prefix}-${next++}`;
  const accountId = seed.accountId ?? "acct";
  const workers = new Map<string, FakeWorker>();
  const namespaces = new Map<string, { title: string; values: Map<string, string> }>();
  const buckets = new Map<string, Map<string, string>>();
  const tokens: BuildToken[] = [...(seed.tokens ?? [])];
  const connections: FakeCloudflare["connections"] = [];
  const triggers = new Map<string, FakeTrigger>();
  const builds = new Map<string, FakeBuild>();
  const applications: { id: string; name: string }[] = [];
  const mutations: string[] = [];
  const requests: FakeCloudflare["requests"] = [];
  const apiTokens = new Map([["cf-token", "tok-user"]]);
  const oauthToken = "cf-oauth";
  const accounts = [accountId, ...(seed.otherAccounts ?? [])].map((id) => ({ id, name: `${id}'s account` }));
  const subdomain = "subdomain" in seed ? seed.subdomain : "acme";

  const workerNamed = (name: string) => {
    let worker = workers.get(name);
    if (!worker) workers.set(name, (worker = { id: id("tag"), name, source: "", secrets: {}, versions: [] }));
    return worker;
  };
  const newVersion = (worker: FakeWorker, containers?: FakeWorker["versions"][number]["containers"]) => {
    const version = { id: id("ver"), number: worker.versions.length + 1, ...(containers && { containers }) };
    worker.versions.unshift(version);
    return version;
  };

  const fake: FakeCloudflare = {
    url: "",
    accountId,
    workers,
    namespaces,
    buckets,
    tokens,
    connections,
    triggers,
    builds,
    applications,
    mutations,
    requests,
    apiTokens,
    oauthToken,
    registerFails: false,
    unseen: new Set(),
    wranglerDeploys: [],
    nextBuild: { outcome: "success", log: ["Cloning repository...", "Success: Deploy command completed"], deploysVersion: true },
    kv: (title) => [...namespaces.values()].find((n) => n.title === title)?.values,
    wranglerDeploy(config, secrets) {
      const worker = workerNamed(config.name);
      worker.config = config;
      worker.source = "achq worker";
      Object.assign(worker.secrets, secrets);
      newVersion(worker, [{ class_name: config.containers[0].class_name, images: {} }]);
      if (!applications.some((a) => a.name === config.containers[0].name)) applications.push({ id: id("app"), name: config.containers[0].name });
    },
    stop: () => server.stop(true),
  };

  const route = async (method: string, path: string, query: URLSearchParams, req: Request, token: string): Promise<Response> => {
    const oauth = token === oauthToken;
    // As Cloudflare answers an OAuth sign-in's token: it isn't an API token.
    if (path === "/user/tokens/verify") return oauth ? fail(401, "Invalid API Token", 1000) : ok({ id: apiTokens.get(token), status: "active" });
    if (path === "/accounts") return ok(accounts);
    const prefix = `/accounts/${accountId}`;
    if (!path.startsWith(prefix)) return fail(403, "Authentication error");
    const p = path.slice(prefix.length);
    requests.push({ call: `${method} ${p}`, token });
    if (p === "") return ok(accounts[0]);
    // Workers Builds doesn't take an OAuth sign-in's token.
    if (oauth && p.startsWith("/builds/")) return fail(403, "Authentication error", 10000);
    if (method !== "GET") mutations.push(`${method} ${p}`);
    let m: RegExpMatchArray | null;

    // ── Workers ──
    if (p === "/workers/subdomain") return subdomain ? ok({ subdomain }) : fail(404, "No subdomain");
    if ((m = p.match(/^\/workers\/workers\/([^/]+)$/)) && method === "GET") {
      const worker = workers.get(decodeURIComponent(m[1]!));
      return worker ? ok({ id: worker.id, name: worker.name }) : fail(404, "Worker not found");
    }
    if ((m = p.match(/^\/workers\/scripts\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]!);
      if (method === "PUT") {
        const form = await req.formData();
        const worker = workerNamed(name);
        worker.source = await (form.get("index.js") as Blob).text();
        newVersion(worker);
        return ok({ id: name });
      }
      if (method === "DELETE") return workers.delete(name) ? ok(null) : fail(404, "Worker not found");
    }
    if ((m = p.match(/^\/workers\/scripts\/([^/]+)\/secrets$/)) && method === "GET") {
      const worker = workers.get(decodeURIComponent(m[1]!));
      return worker ? ok(Object.keys(worker.secrets).map((name) => ({ name, type: "secret_text" }))) : fail(404, "Worker not found");
    }
    if ((m = p.match(/^\/workers\/scripts\/([^/]+)\/secrets$/)) && method === "PUT") {
      const worker = workers.get(decodeURIComponent(m[1]!));
      if (!worker) return fail(404, "Worker not found");
      const { name, text } = (await req.json()) as { name: string; text: string };
      worker.secrets[name] = text;
      newVersion(worker, worker.versions[0]?.containers);
      return ok({ name, type: "secret_text" });
    }
    if ((m = p.match(/^\/workers\/workers\/([^/]+)\/versions(?:\/([^/]+))?$/))) {
      const worker = workers.get(decodeURIComponent(m[1]!));
      if (!worker) return fail(404, "Worker not found");
      if (!m[2]) return ok(worker.versions);
      const version = worker.versions.find((v) => v.id === m![2]);
      return version ? ok(version) : fail(404, "Version not found");
    }

    // ── KV ──
    if (p === "/storage/kv/namespaces") {
      if (method === "POST") {
        const { title } = (await req.json()) as { title: string };
        const nsId = id("ns");
        namespaces.set(nsId, { title, values: new Map() });
        return ok({ id: nsId, title });
      }
      const page = Number(query.get("page") ?? 1);
      const per = Number(query.get("per_page") ?? 20);
      return ok([...namespaces.entries()].map(([nsId, n]) => ({ id: nsId, title: n.title })).slice((page - 1) * per, page * per));
    }
    if ((m = p.match(/^\/storage\/kv\/namespaces\/([^/]+)$/)) && method === "DELETE") return namespaces.delete(m[1]!) ? ok(null) : fail(404, "Namespace not found");
    if ((m = p.match(/^\/storage\/kv\/namespaces\/([^/]+)\/(values\/(.+)|keys)$/))) {
      const ns = namespaces.get(m[1]!);
      if (!ns) return fail(404, "Namespace not found");
      if (m[2] === "keys") {
        const prefixed = [...ns.values.keys()].filter((k) => k.startsWith(query.get("prefix") ?? "")).sort();
        return Response.json({ success: true, errors: [], result: prefixed.map((name) => ({ name })), result_info: { cursor: "" } });
      }
      const key = decodeURIComponent(m[3]!);
      if (method === "GET") return ns.values.has(key) ? new Response(ns.values.get(key)) : fail(404, "key not found");
      if (method === "PUT") ns.values.set(key, await req.text());
      if (method === "DELETE") ns.values.delete(key);
      return ok(null);
    }

    // ── R2 ──
    if (p === "/r2/buckets" && method === "POST") {
      buckets.set(((await req.json()) as { name: string }).name, new Map());
      return ok({});
    }
    if ((m = p.match(/^\/r2\/buckets\/([^/]+)$/)) && method === "DELETE") {
      const bucket = buckets.get(decodeURIComponent(m[1]!));
      if (!bucket) return fail(404, "The specified bucket does not exist");
      if (bucket.size) return fail(409, "The bucket you tried to delete is not empty", 10008);
      buckets.delete(decodeURIComponent(m[1]!));
      return ok({});
    }
    if ((m = p.match(/^\/r2\/buckets\/([^/]+)\/objects$/))) {
      const bucket = buckets.get(decodeURIComponent(m[1]!));
      return bucket ? ok([...bucket.keys()].sort().map((key) => ({ key }))) : fail(404, "The specified bucket does not exist");
    }
    if ((m = p.match(/^\/r2\/buckets\/([^/]+)$/))) return buckets.has(decodeURIComponent(m[1]!)) ? ok({ name: m[1] }) : fail(404, "The specified bucket does not exist");
    if ((m = p.match(/^\/r2\/buckets\/([^/]+)\/objects\/(.+)$/)) && method === "DELETE") {
      buckets.get(decodeURIComponent(m[1]!))?.delete(decodeURIComponent(m[2]!));
      return ok({});
    }

    // ── Builds ──
    if (p === "/builds/tokens" && method === "POST") {
      const body = (await req.json()) as { build_token_name: string; build_token_secret: string; cloudflare_token_id: string };
      if (fake.registerFails) return fail(400, "Unable to create build token");
      if (apiTokens.get(body.build_token_secret) !== body.cloudflare_token_id) return fail(400, "The token's secret and id don't match");
      const token = { build_token_uuid: id("bt"), build_token_name: body.build_token_name, cloudflare_token_id: body.cloudflare_token_id };
      tokens.push(token);
      return ok(token);
    }
    if (p === "/builds/tokens") return ok(tokens);
    if ((m = p.match(/^\/builds\/tokens\/([^/]+)$/)) && method === "DELETE") {
      const at = tokens.findIndex((t) => t.build_token_uuid === m![1]);
      if (at < 0) return fail(404, "Build token not found");
      tokens.splice(at, 1);
      return ok(null);
    }
    if (p === "/builds/repos/connections" && method === "PUT") {
      const body = (await req.json()) as RepoConnection;
      // What Workers Builds answers when its GitHub App can't see the repo.
      if (fake.unseen.has(`${body.provider_account_name}/${body.repo_name}`)) {
        return fail(404, "The project is linked to a repository that no longer exists or is not accessible. Please reconnect the repository.", 8000012);
      }
      let connection = connections.find((c) => c.repo_id === body.repo_id);
      if (!connection) connections.push((connection = { ...body, repo_connection_uuid: id("conn") }));
      Object.assign(connection, body);
      return ok(connection);
    }
    if ((m = p.match(/^\/builds\/workers\/([^/]+)\/triggers$/))) return ok([...triggers.values()].filter((t) => t.external_script_id === m![1]).map(({ variables: _, ...t }) => t));
    if (p === "/builds/triggers" && method === "POST") {
      const body = (await req.json()) as TriggerSettings & { external_script_id: string; repo_connection_uuid: string };
      const connection = connections.find((c) => c.repo_connection_uuid === body.repo_connection_uuid);
      if (!connection) return fail(400, "No such repo connection");
      const { repo_connection_uuid: _, ...settings } = body;
      const trigger: FakeTrigger = {
        ...settings,
        trigger_uuid: id("trig"),
        repo_connection: { repo_connection_uuid: connection.repo_connection_uuid, repo_name: connection.repo_name, provider_account_name: connection.provider_account_name },
        variables: {},
      };
      triggers.set(trigger.trigger_uuid, trigger);
      const { variables: __, ...shown } = trigger;
      return ok(shown);
    }
    if ((m = p.match(/^\/builds\/triggers\/([^/]+)(\/environment_variables|\/builds)?$/))) {
      const trigger = triggers.get(m[1]!);
      if (!trigger) return fail(404, "Trigger not found");
      if (!m[2] && method === "PATCH") Object.assign(trigger, await req.json());
      if (!m[2] && method === "DELETE") triggers.delete(trigger.trigger_uuid);
      if (!m[2]) return ok(trigger);
      if (m[2] === "/environment_variables") {
        if (method === "PATCH") Object.assign(trigger.variables, await req.json());
        return ok(Object.fromEntries(Object.entries(trigger.variables).map(([k, v]) => [k, { is_secret: v.is_secret, value: v.is_secret ? null : v.value }])));
      }
      // A build, which ends at once as `nextBuild` says.
      const { branch } = (await req.json()) as { branch: string };
      const build: FakeBuild = { build_uuid: id("build"), trigger: trigger.trigger_uuid, branch, status: "stopped", build_outcome: fake.nextBuild.outcome, log: fake.nextBuild.log };
      if (fake.nextBuild.outcome === "success" && fake.nextBuild.deploysVersion) {
        const worker = [...workers.values()].find((w) => w.id === trigger.external_script_id)!;
        build.version = newVersion(worker, [{ class_name: "Service", images: { app: `registry.cloudflare.com/${accountId}/${worker.name}-app@sha256:${next}` } }]).id;
        if (!applications.some((a) => a.name === worker.name)) applications.push({ id: id("app"), name: worker.name });
      }
      builds.set(build.build_uuid, build);
      return ok({ build_uuid: build.build_uuid, status: "queued", build_outcome: null });
    }
    if ((m = p.match(/^\/builds\/builds\/([^/]+)(\/logs)?$/))) {
      const build = builds.get(m[1]!);
      if (!build) return fail(404, "Build not found");
      if (m[2]) return ok({ lines: build.log.map((line, i) => [i, line]), truncated: false });
      return ok({ build_uuid: build.build_uuid, status: build.status, build_outcome: build.build_outcome, build_trigger_metadata: { branch: build.branch } });
    }
    if (p === "/builds/builds") {
      const ids = (query.get("version_ids") ?? "").split(",");
      return ok({ builds: Object.fromEntries([...builds.values()].filter((b) => b.version && ids.includes(b.version)).map((b) => [b.version!, { build_uuid: b.build_uuid }])) });
    }

    // ── Containers ──
    if (p === "/containers/applications") return ok(applications.filter((a) => !query.get("name") || a.name === query.get("name")));
    // Each application runs one Durable Object, with its container running.
    if ((m = p.match(/^\/containers\/dash\/applications\/([^/]+)\/instances$/))) {
      if (!applications.some((a) => a.id === m![1])) return fail(404, "Application not found");
      const deployment = `dep-${m[1]}`;
      return ok({ instances: [{ id: deployment, current_placement: { status: { container_status: "running" } } }], durable_objects: [{ id: `do-${m[1]}`, deployment_id: deployment }] });
    }
    if ((m = p.match(/^\/containers\/applications\/([^/]+)$/)) && method === "DELETE") {
      const at = applications.findIndex((a) => a.id === m![1]);
      if (at >= 0) applications.splice(at, 1);
      return ok(null);
    }
    return fail(404, `Fake Cloudflare doesn't know ${method} ${p}`);
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/__wrangler" && req.method === "POST") {
        const { config, secrets, auth } = (await req.json()) as { config: any; secrets: Record<string, string>; auth: string };
        fake.wranglerDeploys.push({ name: config.name, auth });
        fake.wranglerDeploy(config, secrets);
        return new Response("deployed");
      }
      const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!apiTokens.has(token) && token !== oauthToken) return fail(401, "Invalid API Token", 1000);
      return route(req.method, url.pathname.replace(/^\/client\/v4/, ""), url.searchParams, req, token);
    },
  });
  fake.url = `http://localhost:${server.port}/client/v4`;
  return fake;
};

/**
 * A `wrangler` for the fake, signed in to it with OAuth unless `signedIn` is
 * false: `deploy --config <file> --secrets-file <file>` sends what it would
 * deploy to `fake` (failing when `fails` is set), and `auth token --json`
 * prints the token, CLOUDFLARE_API_TOKEN's if that's set, as Wrangler does.
 * Returns the command to run it, for ACHQ_CLOUDFLARE_WRANGLER.
 */
export const fakeWrangler = (fake: FakeCloudflare, { fails = false, signedIn = true } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "achq-fake-wrangler-"));
  const base = fake.url.replace(/\/client\/v4$/, "");
  return fakeBin(
    dir,
    "wrangler",
    `const args = process.argv.slice(2);
const read = (flag) => JSON.parse(require("node:fs").readFileSync(args[args.indexOf(flag) + 1], "utf8"));
const token = process.env.CLOUDFLARE_API_TOKEN;
const notSignedIn = () => { console.error("✘ [ERROR] Not logged in. Please run \`wrangler login\` to authenticate."); process.exit(1); };
if (args[0] === "auth" && args[1] === "token") {
  if (!args.includes("--json")) console.log(" ⛅️ wrangler 4.152.0");
  if (token) console.log(args.includes("--json") ? JSON.stringify({ type: "api_token", token }) : token);
  else if (${signedIn}) console.log(args.includes("--json") ? JSON.stringify({ type: "oauth", token: ${JSON.stringify(fake.oauthToken)} }) : ${JSON.stringify(fake.oauthToken)});
  else notSignedIn();
  process.exit(0);
}
if (${fails}) { console.error("✘ [ERROR] A request to the Cloudflare API failed."); process.exit(1); }
if (!token && !${signedIn}) notSignedIn();
if (!process.env.CLOUDFLARE_ACCOUNT_ID) { console.error("no account"); process.exit(1); }
await fetch(${JSON.stringify(`${base}/__wrangler`)}, { method: "POST", body: JSON.stringify({ config: read("--config"), secrets: read("--secrets-file"), auth: token ? "token" : "oauth" }) });
console.log("Deployed " + read("--config").name);
`,
  );
};
