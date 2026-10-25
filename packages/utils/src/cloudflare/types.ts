import { z } from "zod";

// What Cloudflare answers, as achq reads it: loose, so fields achq doesn't read pass, and only those it reads are declared.

export const AccountSummary = z.looseObject({ id: z.string(), name: z.string() });
export type AccountSummary = z.infer<typeof AccountSummary>;

/** What `/user/tokens/verify` says of an API token. */
export const TokenStatus = z.looseObject({ id: z.string(), status: z.string() });
export type TokenStatus = z.infer<typeof TokenStatus>;

export const WorkersSubdomain = z.looseObject({ subdomain: z.string() });

export const WorkerSecret = z.looseObject({ name: z.string() });
export type WorkerSecret = z.infer<typeof WorkerSecret>;

/** A Worker, by the new Workers API: its `id` is the script tag a Builds trigger names. */
export const WorkerSummary = z.looseObject({ id: z.string() });
export type WorkerSummary = z.infer<typeof WorkerSummary>;

export const KvNamespaceSummary = z.looseObject({ id: z.string(), title: z.string() });
export type KvNamespaceSummary = z.infer<typeof KvNamespaceSummary>;

/** A page of keys' names: the next page's `cursor` is empty on the last. */
export const KvKey = z.looseObject({ name: z.string() });
export const KvKeysInfo = z.looseObject({ cursor: z.string().nullish() }).optional();

export const R2Object = z.looseObject({ key: z.string() });
export const R2ObjectsInfo = z.looseObject({ cursor: z.string().nullish(), is_truncated: z.boolean().nullish() }).optional();

/** A user API token Workers Builds deploys with. The API can't say whether it still works. */
export const BuildToken = z.looseObject({ build_token_uuid: z.string(), build_token_name: z.string(), cloudflare_token_id: z.string().optional() });
export type BuildToken = z.infer<typeof BuildToken>;

/** A GitHub repo, by GitHub's ids, as Workers Builds connects to it. */
export type RepoConnection = {
  provider_type: "github";
  provider_account_id: string;
  provider_account_name: string;
  repo_id: string;
  repo_name: string;
};

export const RepoConnected = z.looseObject({ repo_connection_uuid: z.string() });

const triggerSettings = {
  trigger_name: z.string(),
  build_token_uuid: z.string(),
  build_command: z.string(),
  deploy_command: z.string(),
  root_directory: z.string(),
  branch_includes: z.array(z.string()),
  branch_excludes: z.array(z.string()),
  path_includes: z.array(z.string()),
  path_excludes: z.array(z.string()),
  build_caching_enabled: z.boolean(),
};

/** What a trigger builds and deploys, and when. */
export type TriggerSettings = z.infer<z.ZodObject<typeof triggerSettings>>;

/** Its settings are read back to tell whether they've changed. A trigger without a repo connection is taken as the repo's. */
export const Trigger = z.looseObject({
  ...triggerSettings,
  trigger_uuid: z.string(),
  repo_connection: z.looseObject({ repo_name: z.string(), provider_account_name: z.string() }).nullish(),
});
export type Trigger = z.infer<typeof Trigger>;

/** A secret's value reads as null. */
export const TriggerVariable = z.looseObject({ value: z.string().nullable() });
export type TriggerVariable = z.infer<typeof TriggerVariable>;

/** `status` is "stopped" once it's over, and `build_outcome` then says how it went. */
export const Build = z.looseObject({ build_uuid: z.string(), status: z.string(), build_outcome: z.string().nullable() });
export type Build = z.infer<typeof Build>;

/** The builds that made Worker versions, by version id: only which build each was. */
export const VersionBuilds = z.looseObject({ builds: z.record(z.string(), z.looseObject({ build_uuid: z.string() })).nullish() });

export const BUILD_STOPPED = "stopped";
export const BUILD_SUCCEEDED = "success";

/** A page of a build's log: each line with its time in milliseconds. */
export const BuildLogPage = z.looseObject({
  lines: z.array(z.tuple([z.number(), z.string()])).nullish(),
  truncated: z.boolean(),
  cursor: z.string().nullish(),
});
export type BuildLogPage = z.infer<typeof BuildLogPage>;

/** The images a version's containers run, by class name, then the image's name in its config. */
export const WorkerVersion = z.looseObject({
  id: z.string(),
  containers: z.array(z.looseObject({ class_name: z.string(), images: z.record(z.string(), z.string()) })).optional(),
});
export type WorkerVersion = z.infer<typeof WorkerVersion>;

export const ContainerApplication = z.looseObject({ id: z.string(), name: z.string() });
export type ContainerApplication = z.infer<typeof ContainerApplication>;
