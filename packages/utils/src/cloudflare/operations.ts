import { z } from "zod";
import {
  AccountSummary,
  Build,
  BuildLogPage,
  BuildToken,
  ContainerApplication,
  KvKey,
  KvKeysInfo,
  KvNamespaceSummary,
  R2Object,
  R2ObjectsInfo,
  type RepoConnection,
  RepoConnected,
  TokenStatus,
  Trigger,
  type TriggerSettings,
  TriggerVariable,
  VersionBuilds,
  WorkerSecret,
  WorkerSummary,
  WorkersSubdomain,
  WorkerVersion,
} from "./types.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Query = Record<string, string | number | undefined>;

/**
 * One Cloudflare endpoint: how its parameters make the request, and the
 * schema its envelope's `result` is parsed with. `info`, if it pages, is the
 * schema of the envelope's `result_info`.
 */
export type CloudflareOperation<Params, Result extends z.ZodType, Info extends z.ZodType = z.ZodType> = {
  /** Its key in CLOUDFLARE_OPERATIONS, which errors name. */
  name: string;
  method: Method;
  path: (params: Params) => string;
  query?: (params: Params) => Query;
  /** Sent as JSON. */
  json?: (params: Params) => unknown;
  /** Sent as it is, e.g. a form or a KV value. */
  body?: (params: Params) => string | FormData;
  result: Result;
  info?: Info;
};

type Spec = Omit<CloudflareOperation<any, z.ZodType>, "name">;

/** Each operation, named by its key. */
const named = <T extends Record<string, Spec>>(specs: T) =>
  Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, { ...spec, name }])) as { [K in keyof T]: T[K] & { name: K } };

/** The most a list asks for in one page. */
export const PAGE = 100;
/** How many of a Worker's latest versions a build is looked for in. */
const RECENT_VERSIONS = 20;

/** Names go into paths encoded. */
const enc = encodeURIComponent;

/** A result achq doesn't read. */
const unread = z.unknown();

type Account = { accountId: string };
type Script = Account & { worker: string };
type Namespace = Account & { namespace: string };
type KvValue = Namespace & { key: string };
type Bucket = Account & { bucket: string };
type BuildTrigger = Account & { trigger: string };
type BuildId = Account & { build: string };

const at = ({ accountId }: Account) => `/accounts/${accountId}`;
const script = (p: Script) => `${at(p)}/workers/scripts/${enc(p.worker)}`;
const worker = (p: Script) => `${at(p)}/workers/workers/${enc(p.worker)}`;
const namespace = (p: Namespace) => `${at(p)}/storage/kv/namespaces/${p.namespace}`;
const kvValue = (p: KvValue) => `${namespace(p)}/values/${enc(p.key)}`;
const bucket = (p: Bucket) => `${at(p)}/r2/buckets/${enc(p.bucket)}`;
const trigger = (p: BuildTrigger) => `${at(p)}/builds/triggers/${enc(p.trigger)}`;
const build = (p: BuildId) => `${at(p)}/builds/builds/${enc(p.build)}`;

export const CLOUDFLARE_OPERATIONS = named({
  listAccounts: { method: "GET", path: (_: object) => "/accounts", query: () => ({ per_page: PAGE }), result: z.array(AccountSummary) },
  verifyToken: { method: "GET", path: (_: object) => "/user/tokens/verify", result: TokenStatus },
  getAccount: { method: "GET", path: at, result: AccountSummary },

  // ── Workers ──
  getWorkersSubdomain: { method: "GET", path: (p: Account) => `${at(p)}/workers/subdomain`, result: WorkersSubdomain },
  getWorker: { method: "GET", path: worker, result: WorkerSummary },
  uploadWorker: { method: "PUT", path: script, body: ({ form }: Script & { form: FormData }) => form, result: unread },
  /** And its Durable Objects with it. */
  deleteWorker: { method: "DELETE", path: script, query: () => ({ force: "true" }), result: unread },
  listWorkerSecrets: { method: "GET", path: (p: Script) => `${script(p)}/secrets`, result: z.array(WorkerSecret) },
  putWorkerSecret: {
    method: "PUT",
    path: (p: Script & { name: string; text: string }) => `${script(p)}/secrets`,
    json: ({ name, text }: { name: string; text: string }) => ({ name, text, type: "secret_text" }),
    result: unread,
  },
  listWorkerVersions: {
    method: "GET",
    path: (p: Script) => `${worker(p)}/versions`,
    query: () => ({ per_page: RECENT_VERSIONS }),
    result: z.array(WorkerVersion),
  },
  getWorkerVersion: { method: "GET", path: (p: Script & { version: string }) => `${worker(p)}/versions/${enc(p.version)}`, result: WorkerVersion },

  // ── KV ──
  listKvNamespaces: {
    method: "GET",
    path: (p: Account & { page: number }) => `${at(p)}/storage/kv/namespaces`,
    query: ({ page }: { page: number }) => ({ page, per_page: PAGE }),
    result: z.array(KvNamespaceSummary),
  },
  createKvNamespace: {
    method: "POST",
    path: (p: Account & { title: string }) => `${at(p)}/storage/kv/namespaces`,
    json: ({ title }: { title: string }) => ({ title }),
    result: KvNamespaceSummary,
  },
  deleteKvNamespace: { method: "DELETE", path: namespace, result: unread },
  /** Not an envelope: the value itself. */
  getKvValue: { method: "GET", path: kvValue, result: z.string() },
  putKvValue: { method: "PUT", path: kvValue, body: ({ value }: KvValue & { value: string }) => value, result: unread },
  deleteKvValue: { method: "DELETE", path: kvValue, result: unread },
  listKvKeys: {
    method: "GET",
    path: (p: Namespace & { prefix: string; cursor?: string }) => `${namespace(p)}/keys`,
    query: ({ prefix, cursor }: { prefix: string; cursor?: string }) => ({ prefix, cursor }),
    result: z.array(KvKey),
    info: KvKeysInfo,
  },

  // ── R2 ──
  getR2Bucket: { method: "GET", path: bucket, result: unread },
  createR2Bucket: { method: "POST", path: (p: Account & { name: string }) => `${at(p)}/r2/buckets`, json: ({ name }: { name: string }) => ({ name }), result: unread },
  /** It has to be empty. */
  deleteR2Bucket: { method: "DELETE", path: bucket, result: unread },
  listR2Objects: {
    method: "GET",
    path: (p: Bucket & { cursor?: string }) => `${bucket(p)}/objects`,
    query: ({ cursor }: { cursor?: string }) => ({ per_page: PAGE * 10, cursor }),
    result: z.array(R2Object),
    info: R2ObjectsInfo,
  },
  deleteR2Object: { method: "DELETE", path: (p: Bucket & { key: string }) => `${bucket(p)}/objects/${enc(p.key)}`, result: unread },

  // ── Builds ──
  listBuildTokens: { method: "GET", path: (p: Account) => `${at(p)}/builds/tokens`, query: () => ({ per_page: PAGE }), result: z.array(BuildToken) },
  createBuildToken: {
    method: "POST",
    path: (p: Account & { name: string; secret: string; tokenId: string }) => `${at(p)}/builds/tokens`,
    json: ({ name, secret, tokenId }: { name: string; secret: string; tokenId: string }) => ({ build_token_name: name, build_token_secret: secret, cloudflare_token_id: tokenId }),
    result: BuildToken,
  },
  deleteBuildToken: { method: "DELETE", path: (p: Account & { token: string }) => `${at(p)}/builds/tokens/${enc(p.token)}`, result: unread },
  putRepoConnection: {
    method: "PUT",
    path: (p: Account & { repo: RepoConnection }) => `${at(p)}/builds/repos/connections`,
    json: ({ repo }: { repo: RepoConnection }) => repo,
    result: RepoConnected,
  },
  listWorkerTriggers: { method: "GET", path: (p: Account & { scriptTag: string }) => `${at(p)}/builds/workers/${enc(p.scriptTag)}/triggers`, result: z.array(Trigger) },
  createTrigger: {
    method: "POST",
    path: (p: Account & { scriptTag: string; connection: string; settings: TriggerSettings }) => `${at(p)}/builds/triggers`,
    json: ({ scriptTag, connection, settings }: { scriptTag: string; connection: string; settings: TriggerSettings }) => ({
      external_script_id: scriptTag,
      repo_connection_uuid: connection,
      ...settings,
    }),
    result: Trigger,
  },
  updateTrigger: { method: "PATCH", path: trigger, json: ({ settings }: BuildTrigger & { settings: TriggerSettings }) => settings, result: Trigger },
  deleteTrigger: { method: "DELETE", path: trigger, result: unread },
  listTriggerVariables: { method: "GET", path: (p: BuildTrigger) => `${trigger(p)}/environment_variables`, result: z.record(z.string(), TriggerVariable) },
  /** Sets these, leaving the rest. */
  patchTriggerVariables: {
    method: "PATCH",
    path: (p: BuildTrigger & { variables: Record<string, { value: string; is_secret: boolean }> }) => `${trigger(p)}/environment_variables`,
    json: ({ variables }: { variables: Record<string, { value: string; is_secret: boolean }> }) => variables,
    result: unread,
  },
  startBuild: { method: "POST", path: (p: BuildTrigger & { branch: string }) => `${trigger(p)}/builds`, json: ({ branch }: { branch: string }) => ({ branch }), result: Build },
  getBuild: { method: "GET", path: build, result: Build },
  getBuildLogs: {
    method: "GET",
    path: (p: BuildId & { cursor?: string }) => `${build(p)}/logs`,
    query: ({ cursor }: { cursor?: string }) => ({ cursor }),
    result: BuildLogPage,
  },
  listVersionBuilds: {
    method: "GET",
    path: (p: Account & { versionIds: string[] }) => `${at(p)}/builds/builds`,
    query: ({ versionIds }: { versionIds: string[] }) => ({ version_ids: versionIds.join(",") }),
    result: VersionBuilds,
  },

  // ── Containers ──
  listContainerApplications: {
    method: "GET",
    path: (p: Account & { name: string }) => `${at(p)}/containers/applications`,
    query: ({ name }: { name: string }) => ({ name }),
    result: z.array(ContainerApplication),
  },
  deleteContainerApplication: { method: "DELETE", path: (p: Account & { id: string }) => `${at(p)}/containers/applications/${enc(p.id)}`, result: unread },
});

export type CloudflareOperationName = keyof typeof CLOUDFLARE_OPERATIONS;
