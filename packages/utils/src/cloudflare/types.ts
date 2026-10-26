import * as v from "valibot";

// What Cloudflare answers, as achq reads it: loose, so fields achq doesn't read pass, and only those it reads are declared.

export const AccountSummary = v.looseObject({ id: v.string(), name: v.string() });
export type AccountSummary = v.InferOutput<typeof AccountSummary>;

/** What `/user/tokens/verify` says of an API token. */
export const TokenStatus = v.looseObject({ id: v.string(), status: v.string() });
export type TokenStatus = v.InferOutput<typeof TokenStatus>;

export const WorkersSubdomain = v.looseObject({ subdomain: v.string() });

export const WorkerSecret = v.looseObject({ name: v.string() });
export type WorkerSecret = v.InferOutput<typeof WorkerSecret>;

/** A Worker, by the new Workers API: its `id` is the script tag a Builds trigger names. */
export const WorkerSummary = v.looseObject({ id: v.string() });
export type WorkerSummary = v.InferOutput<typeof WorkerSummary>;

export const KvNamespaceSummary = v.looseObject({ id: v.string(), title: v.string() });
export type KvNamespaceSummary = v.InferOutput<typeof KvNamespaceSummary>;

/** A page of keys' names: the next page's `cursor` is empty on the last. */
export const KvKey = v.looseObject({ name: v.string() });
export const KvKeysInfo = v.optional(v.looseObject({ cursor: v.nullish(v.string()) }));

export const R2Object = v.looseObject({ key: v.string() });
export const R2ObjectsInfo = v.optional(v.looseObject({ cursor: v.nullish(v.string()), is_truncated: v.nullish(v.boolean()) }));

/** A user API token Workers Builds deploys with. The API can't say whether it still works. */
export const BuildToken = v.looseObject({ build_token_uuid: v.string(), build_token_name: v.string(), cloudflare_token_id: v.optional(v.string()) });
export type BuildToken = v.InferOutput<typeof BuildToken>;

/** A GitHub repo, by GitHub's ids, as Workers Builds connects to it. */
export type RepoConnection = {
  provider_type: "github";
  provider_account_id: string;
  provider_account_name: string;
  repo_id: string;
  repo_name: string;
};

export const RepoConnected = v.looseObject({ repo_connection_uuid: v.string() });

const triggerSettings = {
  trigger_name: v.string(),
  build_token_uuid: v.string(),
  build_command: v.string(),
  deploy_command: v.string(),
  root_directory: v.string(),
  branch_includes: v.array(v.string()),
  branch_excludes: v.array(v.string()),
  path_includes: v.array(v.string()),
  path_excludes: v.array(v.string()),
  build_caching_enabled: v.boolean(),
};

/** What a trigger builds and deploys, and when. */
export type TriggerSettings = v.InferOutput<v.ObjectSchema<typeof triggerSettings, undefined>>;

/** Its settings are read back to tell whether they've changed. A trigger without a repo connection is taken as the repo's. */
export const Trigger = v.looseObject({
  ...triggerSettings,
  trigger_uuid: v.string(),
  repo_connection: v.nullish(v.looseObject({ repo_name: v.string(), provider_account_name: v.string() })),
});
export type Trigger = v.InferOutput<typeof Trigger>;

/** A secret's value reads as null. */
export const TriggerVariable = v.looseObject({ value: v.nullable(v.string()) });
export type TriggerVariable = v.InferOutput<typeof TriggerVariable>;

/** `status` is "stopped" once it's over, and `build_outcome` then says how it went. */
export const Build = v.looseObject({ build_uuid: v.string(), status: v.string(), build_outcome: v.nullable(v.string()) });
export type Build = v.InferOutput<typeof Build>;

/** The builds that made Worker versions, by version id: only which build each was. */
export const VersionBuilds = v.looseObject({ builds: v.nullish(v.record(v.string(), v.looseObject({ build_uuid: v.string() }))) });

export const BUILD_STOPPED = "stopped";
export const BUILD_SUCCEEDED = "success";

/** A page of a build's log: each line with its time in milliseconds. */
export const BuildLogPage = v.looseObject({
  lines: v.nullish(v.array(v.tuple([v.number(), v.string()]))),
  truncated: v.boolean(),
  cursor: v.nullish(v.string()),
});
export type BuildLogPage = v.InferOutput<typeof BuildLogPage>;

/** The images a version's containers run, by class name, then the image's name in its config. */
export const WorkerVersion = v.looseObject({
  id: v.string(),
  containers: v.optional(v.array(v.looseObject({ class_name: v.string(), images: v.record(v.string(), v.string()) }))),
});
export type WorkerVersion = v.InferOutput<typeof WorkerVersion>;

export const ContainerApplication = v.looseObject({ id: v.string(), name: v.string() });
export type ContainerApplication = v.InferOutput<typeof ContainerApplication>;

/**
 * An application's instances, as the dashboard lists them: each Durable Object
 * with the deployment running its container, if any. `wrangler containers ssh`
 * takes a Durable Object's id, or an instance's where there are none.
 */
export const ContainerInstances = v.looseObject({
  instances: v.array(
    v.looseObject({
      id: v.string(),
      current_placement: v.nullish(v.looseObject({ status: v.nullish(v.looseObject({ container_status: v.nullish(v.string()), health: v.nullish(v.string()) })) })),
    }),
  ),
  durable_objects: v.nullish(v.array(v.looseObject({ id: v.string(), deployment_id: v.nullish(v.string()) }))),
});
export type ContainerInstances = v.InferOutput<typeof ContainerInstances>;
export const ContainerInstancesInfo = v.nullish(v.looseObject({ next_page_token: v.nullish(v.string()) }));
