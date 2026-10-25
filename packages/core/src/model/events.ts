import type { Json } from "@achq/utils/json";
import type { ThreadRef } from "./threads.ts";

/** An event on a thread a channel delivered, normalised, for containers. Kept small, because the router persists and forwards it. */
export type ChannelEvent = {
  channel: string;
  /** Which configured sender it came through, e.g. a GitHub App's slug. Selectors name one. */
  source: string;
  /** Unique per delivery; containers ignore ones they've handled. */
  delivery: string;
  /** e.g. "issue_comment.created", "issues.edited" */
  type: string;
  repo?: string;
  thread?: ThreadRef;
  /** The thread's labels as of the event, when the channel says. */
  labels?: string[];
  actor?: { login: string; trusted: boolean; bot: boolean };
  /** The text the event carries (a comment or issue body), and for edits, the text before. */
  text?: string;
  previousText?: string;
  /** The message the event is about, as a `Message.id` from `ChannelClient.messages`, when it's one. */
  message?: string;
  /** Anything else the channel needs later, e.g. the comment ID to react to. */
  detail: { [key: string]: Json };
};

/**
 * For the deployer: repos on the infra's code host to deploy, because
 * a source was installed on them or their `.achq/` may have changed on their
 * default branch, and repos to uninstall, because it was removed from them.
 * What the router forwards, once it has decided which repos.
 */
export type DeployerEvent = {
  /** Unique per delivery; the deployer ignores ones it's handled. */
  delivery: string;
  /** e.g. "push", "installation_repositories.added", "deploy.requested" */
  type: string;
  deploy: string[];
  uninstall: string[];
};

/** A `DeployerEvent` as its channel parses it, before the router decides which repos go to the deployer. */
export type RepoEvent = DeployerEvent & {
  /** For a push: only repos already deployed are deployed again. An install is what deploys a repo first. The router filters on it, and doesn't forward it. */
  onlyIfDeployed: boolean;
};

/** Whether a trusted person, not a bot, caused the event: only they start runs. The channel decides who's trusted; this is achq's rule for what that's for. */
export const fromTrustedPerson = (event: ChannelEvent) => Boolean(event.actor?.trusted && !event.actor.bot);

/** A delivery as its channel parses it, tagged with where it goes: a repo event to the deployer, an event on a thread to containers. */
export type ParsedEvent = { to: "deployer"; event: RepoEvent } | { to: "containers"; event: ChannelEvent };
