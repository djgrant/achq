import { randomUUID } from "node:crypto";
import { implementationSecret } from "@achq/core/secrets";
import { hmacHex } from "@achq/core/signing";
import type { FakeGitHub } from "@achq/test-utils/github";

export const KEY = "e2e-agent-webhook-key";
export const OWNER = "notationlabs";
export const REPO = `${OWNER}/yieldstar`;
export const SLUG = "notation-achq";
export const APP_ID = "424242";
export const INSTALLATION = 51_234_567;
export const BOT = `${SLUG}[bot]`;
export const APP_PERMISSIONS = { contents: "write", issues: "write", metadata: "read", pull_requests: "write", actions_variables: "write" };
export const APP_EVENTS = ["issue_comment", "issues", "push"];
/** GitHub's webhook secret for an App: github's label under the router's key. */
const appWebhookSecret = (key: string, appId: string | number) => implementationSecret(key, `github-app-webhook:${appId}`);

/** Someone on GitHub, and their `author_association` with the repo, which GitHub puts on everything they write there. */
export type Person = { user: { login: string; id: number; node_id: string; type: "User" | "Bot"; site_admin: false; html_url: string }; association: string };
const person = (login: string, id: number, association: string, type: "User" | "Bot" = "User"): Person => ({
  user: { login, id, node_id: `U_${id}`, type, site_admin: false, html_url: `https://github.com/${login}` },
  association,
});
export const DJ = person("djgrant", 1_234_567, "OWNER");
export const MALLORY = person("mallory", 7_654_321, "NONE");
/** The App, as GitHub shows it on the comments it posts. */
export const APP_BOT = person(BOT, 190_424_242, "NONE", "Bot");

const account = { login: OWNER, id: 61_000_001, node_id: "O_kgDOBexample", type: "Organization", site_admin: false };
const repository = {
  id: 812_345_678,
  node_id: "R_kgDOexample",
  name: "yieldstar",
  full_name: REPO,
  private: true,
  owner: account,
  html_url: `https://github.com/${REPO}`,
  default_branch: "main",
};
const repositoryRef = { id: repository.id, node_id: repository.node_id, name: repository.name, full_name: REPO, private: true };
const installationRef = { id: INSTALLATION, node_id: "MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uNTEyMzQ1Njc=" };
const installationPayload = {
  id: INSTALLATION,
  account,
  app_id: Number(APP_ID),
  app_slug: SLUG,
  target_id: account.id,
  target_type: "Organization",
  repository_selection: "selected",
  permissions: APP_PERMISSIONS,
  events: APP_EVENTS,
  created_at: "2026-10-01T09:00:00.000Z",
  updated_at: "2026-10-18T09:00:00.000Z",
  suspended_at: null,
};
const onRepo = { repository, organization: { login: OWNER, id: account.id }, installation: installationRef };

type Comment = ReturnType<FakeGitHub["addComment"]>;

/** What came back, and a way to send the same delivery again, as GitHub's retries and "Redeliver" do. */
export type Sent = { status: number; text: string; again: () => Promise<Sent> };

export const githubSends = (github: FakeGitHub, routerUrl: () => string) => {
  /** POSTs a delivery to the router's public /webhook. */
  const deliver = async (event: string, payload: object, delivery = randomUUID()): Promise<Sent> => {
    const body = JSON.stringify(payload);
    const res = await fetch(`${routerUrl()}/webhook`, {
      method: "POST",
      body,
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "user-agent": "GitHub-Hookshot/2b6e3c1",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-github-hook-id": "498765432",
        "x-github-hook-installation-target-type": "integration",
        "x-github-hook-installation-target-id": APP_ID,
        "x-hub-signature": `sha1=${new Bun.CryptoHasher("sha1", appWebhookSecret(KEY, APP_ID)).update(body).digest("hex")}`,
        "x-hub-signature-256": `sha256=${hmacHex(appWebhookSecret(KEY, APP_ID), body)}`,
      },
    });
    return { status: res.status, text: await res.text(), again: () => deliver(event, payload, delivery) };
  };

  const issuePayload = (n: number) => {
    const issue = github.issues.get(`${REPO}#${n}`)!;
    return {
      url: `https://api.github.com/repos/${REPO}/issues/${n}`,
      html_url: `https://github.com/${REPO}/issues/${n}`,
      id: 3_000_000_000 + n,
      node_id: `I_kwDO${n}`,
      number: n,
      title: issue.title,
      user: { ...DJ.user, login: issue.user.login, type: issue.user.type },
      labels: issue.labels.map((l, i) => ({ id: 9_000 + i, node_id: `LA_${i}`, name: l.name, color: "0075ca", default: false, description: null })),
      state: "open",
      locked: false,
      assignee: null,
      assignees: [],
      comments: issue.comments.length,
      created_at: issue.created_at,
      updated_at: new Date().toISOString(),
      closed_at: null,
      author_association: issue.author_association,
      body: issue.body,
      reactions: { total_count: 0 },
    };
  };

  const commentPayload = (n: number, comment: Comment, { user }: Person) => ({
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `https://api.github.com/repos/${REPO}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${REPO}/issues/${n}#issuecomment-${comment.id}`,
    issue_url: `https://api.github.com/repos/${REPO}/issues/${n}`,
    user,
    created_at: comment.created_at,
    updated_at: new Date().toISOString(),
    author_association: comment.author_association,
    body: comment.body,
    reactions: { total_count: 0 },
    performed_via_github_app: null,
  });

  /** A pull request's conversation is an issue whose payload says it's a pull request. */
  const pullRequest = (n: number) => ({
    url: `https://api.github.com/repos/${REPO}/pulls/${n}`,
    html_url: `https://github.com/${REPO}/pull/${n}`,
    diff_url: `https://github.com/${REPO}/pull/${n}.diff`,
    patch_url: `https://github.com/${REPO}/pull/${n}.patch`,
    merged_at: null,
  });

  /** GitHub's `issue_comment.created` for a comment already on issue `n`, such as one the App posted. */
  const commentCreated = (n: number, comment: Comment, sender: Person, options: { pr?: boolean } = {}) =>
    deliver("issue_comment", {
      action: "created",
      issue: { ...issuePayload(n), ...(options.pr && { pull_request: pullRequest(n) }) },
      comment: commentPayload(n, comment, sender),
      ...onRepo,
      sender: sender.user,
    });

  const installationEvent = (action: "created" | "deleted" | "suspend" | "unsuspend") =>
    deliver("installation", { action, installation: installationPayload, repositories: [repositoryRef], requester: null, organization: { login: OWNER, id: account.id }, sender: DJ.user });

  return {
    deliver,

    /** Someone comments on issue `n`: it appears on GitHub, then GitHub delivers `issue_comment.created`. */
    comment(n: number, who: Person, body: string, options: { pr?: boolean } = {}) {
      const added = github.addComment(REPO, n, { body, user: { login: who.user.login, type: who.user.type }, author_association: who.association, created_at: new Date().toISOString() });
      return { comment: added, sent: commentCreated(n, added, who, options) };
    },

    commentCreated,

    /** Someone edits their comment: GitHub sends the text before in `changes.body.from`. */
    edit(n: number, id: number, who: Person, body: string) {
      const existing = github.comments(REPO, n).find((c) => c.id === id)!;
      const from = existing.body;
      existing.body = body;
      return deliver("issue_comment", { action: "edited", changes: { body: { from } }, issue: issuePayload(n), comment: commentPayload(n, existing, who), ...onRepo, sender: who.user });
    },

    /** Someone opens issue `n`: it appears on GitHub, then GitHub delivers `issues.opened`. */
    openIssue(n: number, who: Person, issue: { title: string; body: string; labels?: string[] }) {
      github.addIssue(REPO, {
        number: n,
        title: issue.title,
        body: issue.body,
        user: { login: who.user.login, type: who.user.type },
        author_association: who.association,
        labels: (issue.labels ?? []).map((name) => ({ name })),
        created_at: new Date().toISOString(),
      });
      return deliver("issues", { action: "opened", issue: issuePayload(n), ...onRepo, sender: who.user });
    },

    /** A push to main of `before..after`, which changed `files`. */
    push(before: string, after: string, files: { added?: string[]; modified?: string[]; removed?: string[] }, message = "change") {
      const commit = {
        id: after,
        tree_id: "0".repeat(40),
        distinct: true,
        message,
        timestamp: new Date().toISOString(),
        url: `https://github.com/${REPO}/commit/${after}`,
        author: { name: "DJ Grant", email: "dj@example.com", username: "djgrant" },
        committer: { name: "DJ Grant", email: "dj@example.com", username: "djgrant" },
        added: files.added ?? [],
        removed: files.removed ?? [],
        modified: files.modified ?? [],
      };
      return deliver("push", {
        ref: "refs/heads/main",
        before,
        after,
        repository: { ...repository, master_branch: "main", pushed_at: Math.floor(Date.now() / 1000) },
        pusher: { name: "djgrant", email: "dj@example.com" },
        organization: { login: OWNER, id: account.id },
        installation: installationRef,
        sender: DJ.user,
        created: false,
        deleted: false,
        forced: false,
        base_ref: null,
        compare: `https://github.com/${REPO}/compare/${before.slice(0, 12)}...${after.slice(0, 12)}`,
        commits: [commit],
        head_commit: commit,
      });
    },

    /** The repo is added to or removed from the installation's selected repos. */
    installationRepositories(action: "added" | "removed") {
      return deliver("installation_repositories", {
        action,
        installation: installationPayload,
        repository_selection: "selected",
        repositories_added: action === "added" ? [repositoryRef] : [],
        repositories_removed: action === "removed" ? [repositoryRef] : [],
        requester: null,
        sender: DJ.user,
      });
    },

    /** The whole installation: suspended or unsuspended in the org's settings, or the App uninstalled from the org. */
    installation: installationEvent,
  };
};
