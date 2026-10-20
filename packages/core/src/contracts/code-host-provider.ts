import type { PolicyData } from "../resources/config.ts";
import type { RepoManifest } from "../resources/repo-manifest.ts";
import type { ManagedResource } from "../resources/resource.ts";
import type { Credential } from "./channel-provider.ts";
import type { InstalledRepo, Status } from "../wire/protocol.ts";

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

/**
 * Where repos live. The deployer reads configs from it, the router checks
 * `/wake` against it, containers clone from it. A repo on it is set up for
 * achq or not: installing and uninstalling are its lifecycle.
 */
export interface CodeHostProvider {
  readonly repoName: RegExp;
  /** The policy the deployer's own access to `repo` needs: read `.achq/`, write the status. */
  deployerPolicy(repo: string): PolicyData;
  /** With a credential minted for `deployerPolicy`. */
  repo(repo: string, credential: Credential): RepoClient;
  /** Whether `token` (from `token`) belongs to someone who can push to `repo`. */
  canPush(repo: string, token: string): Promise<boolean>;
  /** Where containers clone `repo` from, with the credentials their policy provider installs. */
  cloneUrl(repo: string): string;

  // ── The CLI, acting as you ──
  /** The repo a git remote URL names, if it's on this host. */
  repoOf(remote: string): string | undefined;
  /** Proves who you are to `canPush`, for `/wake`. */
  token(): string;
  /** The status the deployer last wrote, or undefined if it hasn't. */
  status(repo: string): Promise<Status | undefined>;
  /** The latest commit on `branch` that touched any of `paths`. */
  lastCommit(repo: string, branch: string, paths: string[]): Promise<string>;

  /** CLI, as you: what sets `repo` up for achq, planned and applied like any resource. */
  install(repo: string, manifest: RepoManifest): ManagedResource[];
  /** CLI, as you: what tears it down. */
  uninstall(repo: string, manifest: RepoManifest): ManagedResource[];
  /** Router: the repos currently set up. */
  installed(): Promise<InstalledRepo[]>;
}
