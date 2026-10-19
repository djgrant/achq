import { Issues } from "./issues.ts";
import { type CommentAction, eventSelector, type IssueAction } from "./selectors.ts";

/** A channel a repo adopts by its App's slug: the config side of `Channel`. Its webhooks reach the repo's containers through the router. */
export class ChannelRef {
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
