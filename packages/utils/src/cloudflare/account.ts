import type { AccountSummary, Build, BuildLogPage, BuildToken, ContainerApplication, KvNamespaceSummary, RepoConnection, TokenStatus, Trigger, TriggerSettings, TriggerVariable, WorkerSecret, WorkerSummary, WorkerVersion } from "./types.ts";
import { CLOUDFLARE_API, CloudflareTransport } from "./transport.ts";

/** The most a list asks for in one page. */
const PAGE = 100;
/** How many of a Worker's latest versions a build is looked for in. */
const RECENT_VERSIONS = 20;

/** Names go into paths encoded. */
const enc = encodeURIComponent;

/** One Cloudflare account, as a token reaches it: an API token, or an OAuth sign-in's. Reads nothing until asked. */
export class Cloudflare {
  /** The accounts `token` can reach. */
  static accounts(token: string, endpoint = CLOUDFLARE_API) {
    return new CloudflareTransport(token, endpoint).call<AccountSummary[]>("GET", "/accounts", { query: { per_page: PAGE } });
  }

  readonly transport: CloudflareTransport;
  readonly workers: Workers;
  readonly kv: Kv;
  readonly r2: R2;
  readonly builds: Builds;
  readonly containers: Containers;

  constructor(
    token: string,
    readonly accountId: string,
    endpoint = CLOUDFLARE_API,
  ) {
    this.transport = new CloudflareTransport(token, endpoint);
    const account = `/accounts/${accountId}`;
    this.workers = new Workers(this.transport, account);
    this.kv = new Kv(this.transport, account);
    this.r2 = new R2(this.transport, account);
    this.builds = new Builds(this.transport, account);
    this.containers = new Containers(this.transport, account);
  }

  /** An API token's id, and whether Cloudflare takes it: its status, e.g. "active". An OAuth sign-in's token isn't one, and fails. */
  verifyToken() {
    return this.transport.call<TokenStatus>("GET", "/user/tokens/verify");
  }

  /** The account, as the token sees it: fails if it can't. */
  account() {
    return this.transport.call<AccountSummary>("GET", `/accounts/${this.accountId}`);
  }
}

class Workers {
  constructor(
    private readonly t: CloudflareTransport,
    private readonly account: string,
  ) {}

  /** The account's `<subdomain>.workers.dev`, or undefined before it has one. */
  async subdomain() {
    return (await this.t.find<{ subdomain: string }>("GET", `${this.account}/workers/subdomain`))?.subdomain;
  }

  get(name: string) {
    return this.t.find<WorkerSummary>("GET", `${this.account}/workers/workers/${enc(name)}`);
  }

  /** Uploads `source` as the Worker's one ES module and deploys it: a Worker with no bindings. */
  async upload(name: string, source: string, compatibilityDate: string) {
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ main_module: "index.js", compatibility_date: compatibilityDate })], { type: "application/json" }));
    form.append("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
    await this.t.call("PUT", `${this.account}/workers/scripts/${enc(name)}`, { body: form });
  }

  /** Deletes the Worker, and its Durable Objects with it. */
  async delete(name: string) {
    await this.t.find("DELETE", `${this.account}/workers/scripts/${enc(name)}`, { query: { force: "true" } });
  }

  /** Its secrets' names: their values can't be read back. */
  secrets(worker: string) {
    return this.t.call<WorkerSecret[]>("GET", `${this.account}/workers/scripts/${enc(worker)}/secrets`);
  }

  /** Sets a secret, which deploys a new version of the Worker with it. */
  async putSecret(worker: string, name: string, text: string) {
    await this.t.call("PUT", `${this.account}/workers/scripts/${enc(worker)}/secrets`, { json: { name, text, type: "secret_text" } });
  }

  /** Its latest versions, newest first. */
  versions(worker: string) {
    return this.t.call<WorkerVersion[]>("GET", `${this.account}/workers/workers/${enc(worker)}/versions`, { query: { per_page: RECENT_VERSIONS } });
  }

  version(worker: string, id: string) {
    return this.t.call<WorkerVersion>("GET", `${this.account}/workers/workers/${enc(worker)}/versions/${enc(id)}`);
  }
}

class Kv {
  constructor(
    private readonly t: CloudflareTransport,
    private readonly account: string,
  ) {}

  async namespaces() {
    const all: KvNamespaceSummary[] = [];
    for (let page = 1; ; page++) {
      const found = await this.t.call<KvNamespaceSummary[]>("GET", `${this.account}/storage/kv/namespaces`, { query: { page, per_page: PAGE } });
      all.push(...found);
      if (found.length < PAGE) return all;
    }
  }

  async createNamespace(title: string) {
    return (await this.t.call<KvNamespaceSummary>("POST", `${this.account}/storage/kv/namespaces`, { json: { title } })).id;
  }

  private value(namespace: string, key: string) {
    return `${this.account}/storage/kv/namespaces/${namespace}/values/${enc(key)}`;
  }

  /** The value, or undefined if there's none. Through the API, a read sees the latest write. */
  get(namespace: string, key: string) {
    return this.t.text(this.value(namespace, key));
  }

  async put(namespace: string, key: string, value: string) {
    await this.t.call("PUT", this.value(namespace, key), { body: value });
  }

  async delete(namespace: string, key: string) {
    await this.t.call("DELETE", this.value(namespace, key));
  }

  /** Every key starting with `prefix`. */
  async keys(namespace: string, prefix: string) {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.t.fetch("GET", `${this.account}/storage/kv/namespaces/${namespace}/keys`, { query: { prefix, cursor } });
      const page = (await res.json()) as { result: { name: string }[]; result_info?: { cursor?: string } };
      names.push(...page.result.map((k) => k.name));
      cursor = page.result_info?.cursor || undefined;
    } while (cursor);
    return names;
  }
}

class R2 {
  constructor(
    private readonly t: CloudflareTransport,
    private readonly account: string,
  ) {}

  async exists(bucket: string) {
    return (await this.t.find("GET", `${this.account}/r2/buckets/${enc(bucket)}`)) !== undefined;
  }

  async create(bucket: string) {
    await this.t.call("POST", `${this.account}/r2/buckets`, { json: { name: bucket } });
  }

  /** Deleting a missing object is fine. */
  async deleteObject(bucket: string, key: string) {
    await this.t.find("DELETE", `${this.account}/r2/buckets/${enc(bucket)}/objects/${enc(key)}`);
  }
}

class Builds {
  constructor(
    private readonly t: CloudflareTransport,
    private readonly account: string,
  ) {}

  tokens() {
    return this.t.call<BuildToken[]>("GET", `${this.account}/builds/tokens`, { query: { per_page: PAGE } });
  }

  /** Registers an API token, by its secret and its id, as a token Workers Builds deploys with. */
  registerToken(name: string, secret: string, tokenId: string) {
    return this.t.call<BuildToken>("POST", `${this.account}/builds/tokens`, { json: { build_token_name: name, build_token_secret: secret, cloudflare_token_id: tokenId } });
  }

  /** Creates or updates the connection to a repo, by its ids. Returns its uuid. */
  async connect(repo: RepoConnection) {
    return (await this.t.call<{ repo_connection_uuid: string }>("PUT", `${this.account}/builds/repos/connections`, { json: repo })).repo_connection_uuid;
  }

  /** The triggers that build the Worker whose tag is `scriptTag`. */
  triggers(scriptTag: string) {
    return this.t.call<Trigger[]>("GET", `${this.account}/builds/workers/${enc(scriptTag)}/triggers`);
  }

  createTrigger(scriptTag: string, connection: string, settings: TriggerSettings) {
    return this.t.call<Trigger>("POST", `${this.account}/builds/triggers`, { json: { external_script_id: scriptTag, repo_connection_uuid: connection, ...settings } });
  }

  updateTrigger(trigger: string, settings: TriggerSettings) {
    return this.t.call<Trigger>("PATCH", `${this.account}/builds/triggers/${enc(trigger)}`, { json: settings });
  }

  async deleteTrigger(trigger: string) {
    await this.t.find("DELETE", `${this.account}/builds/triggers/${enc(trigger)}`);
  }

  /** A secret's value reads as null. */
  variables(trigger: string) {
    return this.t.call<Record<string, TriggerVariable>>("GET", `${this.account}/builds/triggers/${enc(trigger)}/environment_variables`);
  }

  /** Sets these, leaving the rest. Each value is at most 5 KB. */
  async setVariables(trigger: string, variables: Record<string, { value: string; is_secret: boolean }>) {
    await this.t.call("PATCH", `${this.account}/builds/triggers/${enc(trigger)}/environment_variables`, { json: variables });
  }

  /** Starts a build of `branch`'s head. */
  start(trigger: string, branch: string) {
    return this.t.call<Build>("POST", `${this.account}/builds/triggers/${enc(trigger)}/builds`, { json: { branch } });
  }

  get(build: string) {
    return this.t.call<Build>("GET", `${this.account}/builds/builds/${enc(build)}`);
  }

  /** Every line of its log, in order. */
  async log(build: string) {
    const lines: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.t.call<BuildLogPage>("GET", `${this.account}/builds/builds/${enc(build)}/logs`, { query: { cursor } });
      lines.push(...(page.lines ?? []).map(([, line]) => line));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return lines;
  }

  /** The build that made each of these Worker versions, by version id. */
  async forVersions(versionIds: string[]) {
    if (!versionIds.length) return {};
    const result = await this.t.call<{ builds: Record<string, Build> }>("GET", `${this.account}/builds/builds`, { query: { version_ids: versionIds.join(",") } });
    return result.builds ?? {};
  }
}

class Containers {
  constructor(
    private readonly t: CloudflareTransport,
    private readonly account: string,
  ) {}

  /** The application named `name`: a Worker's containers, named in its config. */
  async application(name: string) {
    const found = await this.t.call<ContainerApplication[]>("GET", `${this.account}/containers/applications`, { query: { name } });
    return found.find((a) => a.name === name);
  }

  async deleteApplication(id: string) {
    await this.t.find("DELETE", `${this.account}/containers/applications/${enc(id)}`);
  }
}
