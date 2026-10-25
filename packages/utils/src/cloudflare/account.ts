import { CLOUDFLARE_OPERATIONS as OPS, PAGE } from "./operations.ts";
import { CLOUDFLARE_API, CloudflareTransport } from "./transport.ts";
import type { KvNamespaceSummary, RepoConnection, TriggerSettings } from "./types.ts";

/** One Cloudflare account, as a token reaches it: an API token, or an OAuth sign-in's. Reads nothing until asked. */
export class Cloudflare {
  /** The accounts `token` can reach. */
  static accounts(token: string, endpoint = CLOUDFLARE_API) {
    return new CloudflareTransport(token, endpoint).call(OPS.listAccounts, {});
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
    const account = { accountId };
    this.workers = new Workers(this.transport, account);
    this.kv = new Kv(this.transport, account);
    this.r2 = new R2(this.transport, account);
    this.builds = new Builds(this.transport, account);
    this.containers = new Containers(this.transport, account);
  }

  /** An API token's id, and whether Cloudflare takes it: its status, e.g. "active". An OAuth sign-in's token isn't one, and fails. */
  verifyToken() {
    return this.transport.call(OPS.verifyToken, {});
  }

  /** The account, as the token sees it: fails if it can't. */
  account() {
    return this.transport.call(OPS.getAccount, { accountId: this.accountId });
  }
}

type Account = { accountId: string };

class Workers {
  constructor(
    private readonly t: CloudflareTransport,
    private readonly at: Account,
  ) {}

  /** The account's `<subdomain>.workers.dev`, or undefined before it has one. */
  async subdomain() {
    return (await this.t.find(OPS.getWorkersSubdomain, this.at))?.subdomain;
  }

  get(name: string) {
    return this.t.find(OPS.getWorker, { ...this.at, worker: name });
  }

  /** Uploads `source` as the Worker's one ES module and deploys it: a Worker with no bindings. */
  async upload(name: string, source: string, compatibilityDate: string) {
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ main_module: "index.js", compatibility_date: compatibilityDate })], { type: "application/json" }));
    form.append("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
    await this.t.call(OPS.uploadWorker, { ...this.at, worker: name, form });
  }

  /** Deletes the Worker, and its Durable Objects with it. */
  async delete(name: string) {
    await this.t.find(OPS.deleteWorker, { ...this.at, worker: name });
  }

  /** Its secrets' names: their values can't be read back. */
  secrets(worker: string) {
    return this.t.call(OPS.listWorkerSecrets, { ...this.at, worker });
  }

  /** Sets a secret, which deploys a new version of the Worker with it. */
  async putSecret(worker: string, name: string, text: string) {
    await this.t.call(OPS.putWorkerSecret, { ...this.at, worker, name, text });
  }

  /** Its latest versions, newest first. */
  versions(worker: string) {
    return this.t.call(OPS.listWorkerVersions, { ...this.at, worker });
  }

  version(worker: string, id: string) {
    return this.t.call(OPS.getWorkerVersion, { ...this.at, worker, version: id });
  }
}

class Kv {
  constructor(
    private readonly t: CloudflareTransport,
    private readonly at: Account,
  ) {}

  async namespaces() {
    const all: KvNamespaceSummary[] = [];
    for (let page = 1; ; page++) {
      const found = await this.t.call(OPS.listKvNamespaces, { ...this.at, page });
      all.push(...found);
      if (found.length < PAGE) return all;
    }
  }

  async createNamespace(title: string) {
    return (await this.t.call(OPS.createKvNamespace, { ...this.at, title })).id;
  }

  /** Deletes the namespace and every value in it. Deleting a missing one is fine. */
  async deleteNamespace(namespace: string) {
    await this.t.find(OPS.deleteKvNamespace, { ...this.at, namespace });
  }

  /** The value, or undefined if there's none. Through the API, a read sees the latest write. */
  get(namespace: string, key: string) {
    return this.t.text(OPS.getKvValue, { ...this.at, namespace, key });
  }

  /** The value, parsed as JSON, or undefined if there's none or it's empty. */
  async getJson<T>(namespace: string, key: string) {
    const stored = await this.get(namespace, key);
    return stored ? (JSON.parse(stored) as T) : undefined;
  }

  async put(namespace: string, key: string, value: string) {
    await this.t.call(OPS.putKvValue, { ...this.at, namespace, key, value });
  }

  async delete(namespace: string, key: string) {
    await this.t.call(OPS.deleteKvValue, { ...this.at, namespace, key });
  }

  /** Every key starting with `prefix`. */
  async keys(namespace: string, prefix: string) {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const { result, info } = await this.t.page(OPS.listKvKeys, { ...this.at, namespace, prefix, cursor });
      names.push(...result.map((k) => k.name));
      cursor = info?.cursor || undefined;
    } while (cursor);
    return names;
  }
}

class R2 {
  constructor(
    private readonly t: CloudflareTransport,
    private readonly at: Account,
  ) {}

  async exists(bucket: string) {
    return (await this.t.find(OPS.getR2Bucket, { ...this.at, bucket })) !== undefined;
  }

  async create(bucket: string) {
    await this.t.call(OPS.createR2Bucket, { ...this.at, name: bucket });
  }

  /** Deletes the bucket, which has to be empty. Deleting a missing one is fine. */
  async delete(bucket: string) {
    await this.t.find(OPS.deleteR2Bucket, { ...this.at, bucket });
  }

  /** Every object's key. */
  async keys(bucket: string) {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const { result, info } = await this.t.page(OPS.listR2Objects, { ...this.at, bucket, cursor });
      keys.push(...result.map((o) => o.key));
      cursor = (info?.is_truncated && info.cursor) || undefined;
    } while (cursor);
    return keys;
  }

  /** Deleting a missing object is fine. */
  async deleteObject(bucket: string, key: string) {
    await this.t.find(OPS.deleteR2Object, { ...this.at, bucket, key });
  }
}

class Builds {
  constructor(
    private readonly t: CloudflareTransport,
    private readonly at: Account,
  ) {}

  tokens() {
    return this.t.call(OPS.listBuildTokens, this.at);
  }

  /** Registers an API token, by its secret and its id, as a token Workers Builds deploys with. */
  registerToken(name: string, secret: string, tokenId: string) {
    return this.t.call(OPS.createBuildToken, { ...this.at, name, secret, tokenId });
  }

  /** Unregisters a token from Workers Builds; the API token itself is kept. Deleting a missing one is fine. */
  async deleteToken(uuid: string) {
    await this.t.find(OPS.deleteBuildToken, { ...this.at, token: uuid });
  }

  /** Creates or updates the connection to a repo, by its ids. Returns its uuid. */
  async connect(repo: RepoConnection) {
    return (await this.t.call(OPS.putRepoConnection, { ...this.at, repo })).repo_connection_uuid;
  }

  /** The triggers that build the Worker whose tag is `scriptTag`. */
  triggers(scriptTag: string) {
    return this.t.call(OPS.listWorkerTriggers, { ...this.at, scriptTag });
  }

  createTrigger(scriptTag: string, connection: string, settings: TriggerSettings) {
    return this.t.call(OPS.createTrigger, { ...this.at, scriptTag, connection, settings });
  }

  updateTrigger(trigger: string, settings: TriggerSettings) {
    return this.t.call(OPS.updateTrigger, { ...this.at, trigger, settings });
  }

  async deleteTrigger(trigger: string) {
    await this.t.find(OPS.deleteTrigger, { ...this.at, trigger });
  }

  /** A secret's value reads as null. */
  variables(trigger: string) {
    return this.t.call(OPS.listTriggerVariables, { ...this.at, trigger });
  }

  /** Sets these, leaving the rest. Each value is at most 5 KB. */
  async setVariables(trigger: string, variables: Record<string, { value: string; is_secret: boolean }>) {
    await this.t.call(OPS.patchTriggerVariables, { ...this.at, trigger, variables });
  }

  /** Starts a build of `branch`'s head. */
  start(trigger: string, branch: string) {
    return this.t.call(OPS.startBuild, { ...this.at, trigger, branch });
  }

  get(build: string) {
    return this.t.call(OPS.getBuild, { ...this.at, build });
  }

  /** Every line of its log, in order. */
  async log(build: string) {
    const lines: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.t.call(OPS.getBuildLogs, { ...this.at, build, cursor });
      lines.push(...(page.lines ?? []).map(([, line]) => line));
      cursor = (page.truncated && page.cursor) || undefined;
    } while (cursor);
    return lines;
  }

  /** The build that made each of these Worker versions, by version id. */
  async forVersions(versionIds: string[]) {
    if (!versionIds.length) return {};
    return (await this.t.call(OPS.listVersionBuilds, { ...this.at, versionIds })).builds ?? {};
  }
}

class Containers {
  constructor(
    private readonly t: CloudflareTransport,
    private readonly at: Account,
  ) {}

  /** The application named `name`: a Worker's containers, named in its config. */
  async application(name: string) {
    const found = await this.t.call(OPS.listContainerApplications, { ...this.at, name });
    return found.find((a) => a.name === name);
  }

  async deleteApplication(id: string) {
    await this.t.find(OPS.deleteContainerApplication, { ...this.at, id });
  }
}
