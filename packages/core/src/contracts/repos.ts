import type { PolicyData } from "../model/resources.ts";
import type { Credential } from "./channel.ts";
import type { Status } from "./protocol.ts";

/** A repo's default branch head, and the `.achq` tree in it. */
export type ConfigTree = {
  commit: string;
  branch: string;
  /** The `.achq` tree's id, or undefined when the commit has no `.achq/`. */
  tree?: string;
  /** Every file under `.achq/`, by path relative to it. */
  blobs: Map<string, { sha: string; size: number }>;
};

export type FileLimits = { maxFiles: number; maxBytes: number };

/** One repo, as the deployer's own credential reaches it. */
export interface RepoClient {
  config(): Promise<ConfigTree>;
  /** `paths` (relative to `.achq/`) as UTF-8, within `limits`. */
  download(tree: ConfigTree, paths: string[], limits: FileLimits): Promise<Record<string, string>>;
  /** Writes ACHQ_STATUS where the repo's CLI reads it. */
  writeStatus(status: Status): Promise<void>;
}

/** Where repos live. The deployer reads configs from it, the router checks `/wake` against it, containers clone from it. */
export interface RepoHost {
  /** What a repo's name looks like here, e.g. `owner/name`. */
  readonly repoName: RegExp;
  /** The policy the deployer's own access to `repo` needs, through `source`: read `.achq/`, write the status. */
  deployerPolicy(source: string, repo: string): PolicyData;
  /** With a credential minted for `deployerPolicy`. */
  repo(repo: string, credential: Credential): RepoClient;
  /** Whether `token` (from `RepoCli.token`) belongs to someone who can push to `repo`. */
  canPush(repo: string, token: string): Promise<boolean>;
  /** Where containers clone `repo` from, with the credentials their access provider installs. */
  cloneUrl(repo: string): string;
}
