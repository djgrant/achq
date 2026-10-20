import type { ChannelEvent, Data } from "@achq/core";
import { hmacHex, safeEqual } from "@achq/core/signing";
import { CHANNEL, CODE_HOST } from "./constants.ts";
import { issueThreadId, labelNames, messageId, OPENING_POST_ID, TRUSTED } from "./threads.ts";

/** The directory whose changes redeploy a repo. */
const CONFIG_DIR = ".achq/";

/**
 * A webhook `push` payload's `commits` array "includes a maximum of 2048
 * commits" (https://docs.github.com/en/webhooks/webhook-events-and-payloads#push).
 * A push listing that many may have dropped some, so it can't tell us whether
 * `.achq/` changed. The limit of 20 is the Events API's, not webhooks'.
 */
const PUSH_COMMIT_CAP = 2048;

const ISSUE_ACTIONS = new Set(["opened", "edited", "reopened", "labeled"]);
const COMMENT_ACTIONS = new Set(["created", "edited"]);
const INSTALLATION_ACTIONS = new Set(["created", "deleted", "suspend", "unsuspend"]);
const INSTALLATION_REPOS_ACTIONS = new Set(["added", "removed"]);

/** Checks GitHub's X-Hub-Signature-256 header against the raw body. */
export const verifyGitHubSignature = (secret: string, body: string, header: string | null) =>
  Boolean(header?.startsWith("sha256=")) && safeEqual(header!, `sha256=${hmacHex(secret, body)}`);

const fullNames = (repos: unknown): string[] =>
  Array.isArray(repos) ? repos.map((r) => r?.full_name).filter((n): n is string => typeof n === "string") : [];

type EventBase = Pick<ChannelEvent, "channel" | "source" | "delivery">;

/** The payload is GitHub's, so it's read defensively. */
type Delivery = { name: string; base: EventBase; payload: any };

const commitTouches = (commit: any, dir: string) =>
  [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])].some((file: string) => file.startsWith(dir));

/** `issues` and `issue_comment`, on issues only (not pull requests). */
const parseIssueEvent = ({ name, base, payload }: Delivery): ChannelEvent | undefined => {
  const repo: string | undefined = payload.repository?.full_name;
  const { issue, action } = payload;
  if (!repo || !issue || issue.pull_request) return undefined;
  if (!(name === "issues" ? ISSUE_ACTIONS : COMMENT_ACTIONS).has(action)) return undefined;
  const comment = name === "issue_comment" ? payload.comment : undefined;
  if (name === "issue_comment" && !comment) return undefined;
  const author = comment ?? issue;
  const text: string = author.body ?? "";
  const detail: { [key: string]: Data } = { issue: issue.number };
  if (comment) detail.comment = comment.id;
  if (action === "labeled" && payload.label?.name) detail.label = payload.label.name;
  return {
    ...base,
    type: `${name}.${action}`,
    repo,
    thread: { channel: CHANNEL, id: issueThreadId(repo, issue.number) },
    labels: labelNames(issue.labels),
    actor: {
      login: author.user?.login ?? "",
      // Content is only trusted when both the issue and the comment come from people with write access.
      trusted: TRUSTED.has(author.author_association) && TRUSTED.has(issue.author_association),
      bot: author.user?.type === "Bot",
    },
    text,
    // An edit that didn't touch the body (e.g. a title change) has no `changes.body`: the text before is the text now.
    ...(action === "edited" && { previousText: typeof payload.changes?.body?.from === "string" ? payload.changes.body.from : text }),
    message: comment ? messageId(comment.id) : OPENING_POST_ID,
    detail,
  };
};

const parsePushEvent = ({ base, payload }: Delivery): ChannelEvent | undefined => {
  const repo: string | undefined = payload.repository?.full_name;
  if (!repo) return undefined;
  const commits: any[] = Array.isArray(payload.commits) ? payload.commits : [];
  const touchesConfig = commits.some((commit) => commitTouches(commit, CONFIG_DIR));
  const truncated = commits.length >= PUSH_COMMIT_CAP;
  const onDefaultBranch = payload.ref === `refs/heads/${payload.repository?.default_branch}`;
  return {
    ...base,
    type: "push",
    repo,
    host: CODE_HOST,
    configChanged: onDefaultBranch && (touchesConfig || truncated),
    detail: { ref: payload.ref ?? "", after: payload.after ?? "", deleted: Boolean(payload.deleted) },
  };
};

const parseInstallationEvent = ({ name, base, payload }: Delivery): ChannelEvent | undefined => {
  const { action } = payload;
  const actions = name === "installation" ? INSTALLATION_ACTIONS : INSTALLATION_REPOS_ACTIONS;
  if (!actions.has(action)) return undefined;
  return {
    ...base,
    type: `${name}.${action}`,
    host: CODE_HOST,
    installation: name === "installation" ? installationChange(payload) : repositoriesChange(payload),
    detail: { installation: payload.installation?.id ?? 0, account: payload.installation?.account?.login ?? "" },
  };
};

/** For an installation, the repos it covers (when GitHub lists them): suspending removes them, unsuspending adds them back. */
const installationChange = (payload: any) => {
  const listed = fullNames(payload.repositories);
  const adds = payload.action === "created" || payload.action === "unsuspend";
  return { added: adds ? listed : [], removed: adds ? [] : listed };
};

const repositoriesChange = (payload: any) => ({ added: fullNames(payload.repositories_added), removed: fullNames(payload.repositories_removed) });

const PARSERS: Record<string, (delivery: Delivery) => ChannelEvent | undefined> = {
  issues: parseIssueEvent,
  issue_comment: parseIssueEvent,
  push: parsePushEvent,
  installation: parseInstallationEvent,
  installation_repositories: parseInstallationEvent,
};

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/**
 * Normalises a verified delivery. Never carries the raw payload: only what the
 * router filters on and the container needs later.
 */
export const parseEvent = (source: string, headers: Headers, body: string): ChannelEvent | undefined => {
  const name = headers.get("x-github-event");
  const delivery = headers.get("x-github-delivery");
  if (!name || !delivery) return undefined;
  const parse = Object.hasOwn(PARSERS, name) ? PARSERS[name]! : undefined;
  const payload = parseJson(body);
  if (!parse || payload === undefined) return undefined;
  return parse({ name, base: { channel: CHANNEL, source, delivery }, payload });
};
