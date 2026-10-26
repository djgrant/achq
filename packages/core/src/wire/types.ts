/*
 * The protocol's types that core's contracts use, as plain types: core's index
 * exports these, so it and its declarations have no zod. protocol.ts's schemas
 * check against them. Where a loose schema reads what another version of achq
 * wrote, keys this version doesn't know pass through: `[key: string]: unknown`.
 */

/** A command your machine runs to open a shell in a container, as its container provider computed it just now, and the binaries it needs there. */
export type Shell = { argv: string[]; env?: Record<string, string>; requires: { binary: string; install: string }[] };

export type InstalledRepo = { repo: string; [key: string]: unknown };

/**
 * A source's installation on a repo, as the router's code host sees it: whether
 * it covers the repo, and the page where you change that, e.g. a GitHub App's
 * install page, or its installation's settings, where you choose its repos.
 */
export type RepoInstallation = { installed: boolean; url: string; [key: string]: unknown };

/** What a source (e.g. a GitHub App) is set up to send and allow, for checks. */
export type SourceSettings = { channel: string; source: string; events: string[]; permissions: Record<string, string>; [key: string]: unknown };

export type DeployState = "deployed" | "failed" | "uninstalled";

/** The deployer's record of a repo, as ACHQ_STATUS and `/admin/status` show it. */
export type DeployRecord = {
  repo: string;
  state: DeployState;
  at: string;
  error?: string;
  commit?: string;
  /** The containers deployed, by name: the router's `/reach` opens a shell in one. */
  containers?: { name: string; [key: string]: unknown }[];
  warnings?: string[];
  /** What only you can do to fix a failed deploy, in your browser (a BrowserAction). `achq repo install` opens it, then deploys again. */
  action?: { url: string; what: string; [key: string]: unknown };
  [key: string]: unknown;
};

/** The status the deployer writes where the repo's CLI reads it, e.g. GitHub's ACHQ_STATUS variable: its record, and the router's public URL. */
export type Status = DeployRecord & { router: string };
