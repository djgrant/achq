import { type Deployer, type Router, Resource } from "@achq/core";
import { type CommentAction, eventSelector, type IssueAction } from "./events.ts";
import { Issues } from "./issues.ts";

/** A GitHub App a repo adopts by slug. Its webhooks reach the repo's containers through the router. */
export class AppRef {
  readonly issues: Issues;
  constructor(readonly slug: string) {
    this.issues = new Issues(slug);
  }

  /** Events on an issue itself. */
  issue(options: { actions?: IssueAction[]; mention?: string; labels?: string[] } = {}) {
    return eventSelector(this.slug, "issues", options.actions ?? ["opened"], options);
  }

  /** New or edited comments on an issue. */
  issueComment(options: { actions?: CommentAction[]; mention?: string; labels?: string[] } = {}) {
    return eventSelector(this.slug, "issue_comment", options.actions ?? ["created"], options);
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
