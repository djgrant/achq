import { ThreadSelector } from "@achq/core";
import { CHANNEL } from "./constants.ts";

/** Labels a thread must all have. */
export type IssueFilter = { labels?: string[] };

export type IssueSelectorData = { channel: typeof CHANNEL; source: string; kind: "issue"; labels?: string[] };

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
