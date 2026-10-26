import type { Vars } from "@achq/utils/env";
import type { Credential } from "../model/credentials.ts";
import type { RepoManifest } from "../model/manifest.ts";
import type { RepoIdentity } from "../model/repos.ts";
import type { PolicyData } from "../model/resource-data.ts";
import type { Implementation } from "./implementation.ts";
import type { InstalledRepo, RepoInstallation, Status } from "../wire/protocol.ts";

/** A repo's default branch head, and the `.achq` tree in it. */
export type ConfigTree = {
  /** Read with the deployer's credential, so a private repo's too. */
  identity: RepoIdentity;
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
  /** Deletes ACHQ_STATUS, as if the repo had never been deployed: the router it names is going. */
  clearStatus(): Promise<void>;
}

/**
 * Where repos live, as achq's services reach it, made from their env: the
 * deployer reads configs from it, the router checks `/reach` against it and
 * lists the repos set up for achq, containers clone from it. A repo on it is
 * set up for achq or not: installing and uninstalling are its lifecycle.
 */
export interface CodeHostProvider {
  /** What a repo's `owner/name` looks like on this host: the deployer deploys nothing else. */
  readonly repoName: RegExp;

  // ── Deployer ──
  /** The policy the deployer's own access to `repo` needs: read `.achq/`, write the status. */
  deployerPolicy(repo: string): PolicyData;
  /** With a credential minted for `deployerPolicy`. */
  repo(repo: string, credential: Credential): RepoClient;

  // ── Container ──
  /** Where containers clone `repo` from, with the credentials their policy provider installs. */
  cloneUrl(repo: string): string;

  // ── Router ──
  /** Whether `token` (from `CodeHostAsYou.token`) belongs to someone who can push to `repo`. */
  canPush(repo: string, token: string): Promise<boolean>;
  /** The repos currently set up. */
  installed(): Promise<InstalledRepo[]>;
  /**
   * For `POST /installation`: whether `source` (a config's, e.g. a GitHub
   * App's slug) is installed on `repo`, and where you'd change that.
   * Undefined for a source the router doesn't have. Only the router can tell:
   * on GitHub it takes the App's key.
   */
  installation(repo: string, source: string): Promise<RepoInstallation | undefined>;
}

/** What `checkSource` found: what the source lacks that the config needs, and what it couldn't check. */
export type SourceCheck = { missing: string[]; warnings: string[] };

/**
 * The code host as the CLI reaches it, acting as you through your own login,
 * e.g. `gh`'s: without the infra's vault or any App's key.
 */
export interface CodeHostAsYou {
  /** What a repo's `owner/name` looks like on this host. */
  readonly repoName: RegExp;
  /** The repo a git remote URL names, if it's on this host. */
  repoOf(remote: string): string | undefined;
  /** Proves who you are to the router's `canPush`, for its public endpoints. */
  token(): string;
  /** The status the deployer last wrote, or undefined if it hasn't. */
  status(repo: string): Promise<Status | undefined>;
  /** Where the status is kept, for messages, e.g. ``acme/w's `ACHQ_STATUS` variable``. */
  statusLocation(repo: string): string;
  /** Deletes the status, as if the repo had never been deployed: once it's uninstalled, the deployer can't reach it. */
  clearStatus(repo: string): Promise<void>;
  /** The latest commit on `branch` that touched any of `paths`. */
  lastCommit(repo: string, branch: string, paths: string[]): Promise<string>;

  // ── Installing and uninstalling a repo ──
  /** The one source (e.g. a GitHub App's slug) the config is served through, which installing puts on the repo. Throws unless there's exactly one. */
  sourceOf(manifest: RepoManifest): string;
  /** What `source` lacks of what `manifest` needs, as far as you can see it. */
  checkSource(source: string, manifest: RepoManifest): Promise<SourceCheck>;
  /** Where you install `source` on a repo, when there's no router to say where. */
  installPage(source: string): string;
  /** What to do at `url`, which the router or `installPage` gave, to install `source` on `repo` or remove it. */
  howTo(change: "install" | "remove", source: string, repo: string, url: string): string;
}

/** A code host's services' side, made with `create`, and the CLI's, made with `asYou`. An infra has one: the registry's `CODE_HOST`. */
export type CodeHostImplementation = Implementation<CodeHostProvider> & {
  asYou(env: Vars): CodeHostAsYou;
};
