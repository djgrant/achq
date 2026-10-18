import { type Deployer, type Router, EventSelector, Policy, Resource, ThreadSelector } from "@achq/core";

export const CHANNEL = "github";

/** Labels a thread must all have. */
export type IssueFilter = { labels?: string[] };

export type IssueSelectorData = { channel: "github"; source: string; kind: "issue"; labels?: string[] };

export type EventSelectorData = {
  channel: "github";
  source: string;
  event: "issues" | "issue_comment";
  actions: string[];
  /** Only when the text newly mentions this, e.g. "@claude". For edits, a mention already there before doesn't count. */
  mention?: string;
  /** Only on threads with all of these labels. */
  labels?: string[];
};

/** The App's issues, or the ones matching a filter. A description, not a list. */
export class Issues extends ThreadSelector {
  declare readonly data: IssueSelectorData;
  constructor(source: string, filter: IssueFilter = {}) {
    super({ channel: CHANNEL, source, kind: "issue", ...(filter.labels && { labels: filter.labels }) });
  }
  where(filter: IssueFilter) {
    return new Issues(this.data.source, { labels: [...(this.data.labels ?? []), ...(filter.labels ?? [])] });
  }
}

type IssueAction = "opened" | "edited" | "reopened" | "labeled";
type CommentAction = "created" | "edited";

/** A GitHub App a repo adopts by slug. Its webhooks reach the repo's containers through the router. */
export class AppRef {
  readonly issues: Issues;
  constructor(readonly slug: string) {
    this.issues = new Issues(slug);
  }

  /** Events on an issue itself. */
  issue(options: { actions?: IssueAction[]; mention?: string; labels?: string[] } = {}) {
    return this.event("issues", options.actions ?? ["opened"], options);
  }

  /** New or edited comments on an issue. */
  issueComment(options: { actions?: CommentAction[]; mention?: string; labels?: string[] } = {}) {
    return this.event("issue_comment", options.actions ?? ["created"], options);
  }

  private event(event: EventSelectorData["event"], actions: string[], options: { mention?: string; labels?: string[] }) {
    const data: EventSelectorData = {
      channel: CHANNEL,
      source: this.slug,
      event,
      actions,
      ...(options.mention && { mention: options.mention }),
      ...(options.labels && { labels: options.labels }),
    };
    return new EventSelector(data);
  }
}

export type AppInputs = {
  /** The App's name on GitHub, which its slug comes from. */
  name: string;
  /** The organisation that owns it. Without one it's owned by your account and public, so others can install it. */
  org?: string;
  router: Router;
  deployer: Deployer;
};

/**
 * Declared in the ACHQ infra. Its webhooks go to the router, and the router
 * mints its tokens. Its installations decide which repos the deployer serves.
 */
export class App extends Resource {
  readonly kind = "github-app";
  constructor(
    name: string,
    readonly inputs: AppInputs,
  ) {
    super(name);
  }

  /** Adopts an App declared in the ACHQ infra, by its slug. */
  static get(slug: string) {
    return new AppRef(slug);
  }
}

export type Permission = "read" | "write";

export type RepoPolicyData = {
  provider: "github";
  app: string;
  /** `owner/name`, or null for the repo the config is in. */
  repo: string | null;
  permissions: Record<string, Permission>;
};

/** Access to one repo through an App's installation. Defaults to the config's own repo. */
export class RepoPolicy extends Policy {
  constructor(name: string, inputs: { app: AppRef; repo?: string; permissions: Record<string, Permission> }) {
    const data: RepoPolicyData = { provider: "github", app: inputs.app.slug, repo: inputs.repo ?? null, permissions: inputs.permissions };
    super(name, data);
  }
}
