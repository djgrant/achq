/*
 * The protocol's types that core's contracts use, as plain types: core's index
 * exports these, so it and its declarations have no schema library. protocol.ts's schemas
 * check against them.
 */

/** What another version of achq wrote, as a loose schema reads it: keys this version doesn't know pass through. */
type Loose<T> = T & { [key: string]: unknown };

/** One object of T's fields, as a schema that spreads another's entries infers it. */
type Flat<T> = { [K in keyof T]: T[K] };

/** A command your machine runs to open a shell in a container, as its container provider computed it just now, and the binaries it needs there. */
export type Shell = { argv: string[]; env?: Record<string, string>; requires: { binary: string; install: string }[] };

export type InstalledRepo = Loose<{ repo: string }>;

/**
 * A source's installation on a repo, as the router's code host sees it: whether
 * it covers the repo, and the page where you change that, e.g. a GitHub App's
 * install page, or its installation's settings, where you choose its repos.
 */
export type RepoInstallation = Loose<{ installed: boolean; url: string }>;

/** What a source (e.g. a GitHub App) is set up to send and allow, for checks. */
export type SourceSettings = Loose<{ channel: string; source: string; events: string[]; permissions: { [key: string]: string } }>;

export type DeployState = "deployed" | "failed" | "uninstalled";

/** The deployer's record of a repo's fields. */
type RecordFields = {
  repo: string;
  state: DeployState;
  at: string;
  error?: string;
  commit?: string;
  /** The containers deployed, by name: the router's `/reach` opens a shell in one. */
  containers?: Loose<{ name: string }>[];
  warnings?: string[];
  /** What only you can do to fix a failed deploy, in your browser (a BrowserAction). `achq repo install` opens it, then deploys again. */
  action?: Loose<{ url: string; what: string }>;
};

/** The deployer's record of a repo, as ACHQ_STATUS and `/admin/status` show it. */
export type DeployRecord = Loose<RecordFields>;

/** The status the deployer writes where the repo's CLI reads it, e.g. GitHub's ACHQ_STATUS variable: its record, and the router's public URL. */
export type Status = Loose<Flat<RecordFields & { router: string }>>;
