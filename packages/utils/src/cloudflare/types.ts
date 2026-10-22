/** A Worker, by the new Workers API: its `id` is the script tag a Builds trigger names. */
export type WorkerSummary = { id: string; name: string };

export type KvNamespaceSummary = { id: string; title: string };

/** A user API token Workers Builds deploys with. The API can't say whether it still works. */
export type BuildToken = { build_token_uuid: string; build_token_name: string; cloudflare_token_id?: string };

/** A GitHub repo, by GitHub's ids, as Workers Builds connects to it. */
export type RepoConnection = {
  provider_type: "github";
  provider_account_id: string;
  provider_account_name: string;
  repo_id: string;
  repo_name: string;
};

/** What a trigger builds and deploys, and when. */
export type TriggerSettings = {
  trigger_name: string;
  build_token_uuid: string;
  build_command: string;
  deploy_command: string;
  root_directory: string;
  branch_includes: string[];
  branch_excludes: string[];
  path_includes: string[];
  path_excludes: string[];
  build_caching_enabled: boolean;
};

export type Trigger = TriggerSettings & {
  trigger_uuid: string;
  external_script_id: string;
  repo_connection?: { repo_connection_uuid: string; repo_name: string; provider_account_name: string };
};

export type TriggerVariable = { value: string | null; is_secret: boolean };

/** `status` is "stopped" once it's over, and `build_outcome` then says how it went. */
export type Build = {
  build_uuid: string;
  status: string;
  build_outcome: string | null;
  build_trigger_metadata?: { branch?: string; commit_hash?: string };
};

export const BUILD_STOPPED = "stopped";
export const BUILD_SUCCEEDED = "success";

/** A page of a build's log: each line with its time in milliseconds. */
export type BuildLogPage = { lines: [number, string][]; truncated: boolean; cursor?: string };

/** The images a version's containers run, by class name, then the image's name in its config. */
export type WorkerVersion = { id: string; number: number; containers?: { class_name: string; name?: string; images: Record<string, string> }[] };

export type ContainerApplication = { id: string; name: string };

export type ContainerInstance = { id: string; state?: string };
