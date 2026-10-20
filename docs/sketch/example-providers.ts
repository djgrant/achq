import {
  type AccessProvider, type Agent, type Channel, type ContainerHost, type Data, type Deployable,
  type EventSelector, Policy, Resource, type RouterHost, type ThreadSelector, type Deployer, type Router,
} from "./primitives.ts";

// ─── GitHub ──────────────────────────────────────────────────────────────────

type IssueAction = "opened" | "edited" | "closed" | "reopened" | "labeled";
type CommentAction = "created" | "edited";
type Permission = "read" | "write";
type Permissions = Partial<Record<"contents" | "issues" | "pull_requests" | "actions" | "variables", Permission>>;

type AppInputs = { name: string; org?: string; router: Router; deployer: Deployer };

/** A GitHub App: a channel, an access provider, and something `up` creates. */
export declare class GitHubApp extends Resource<AppInputs> implements Channel, AccessProvider, Deployable<{ id: number; slug: string }> {
  /** Adopts an App declared elsewhere (in the infra), by slug. */
  static get(slug: string): GitHubApp;

  // Selectors: plain data, typed for any GitHub App.
  readonly issues: ThreadSelector & { where(filter: { labels?: string[]; author?: string }): ThreadSelector };
  issue(filter?: { actions?: IssueAction[]; mention?: string; labels?: string[] }): EventSelector;
  issueComment(filter?: { actions?: CommentAction[]; mention?: string }): EventSelector;

  // Channel, AccessProvider, Deployable
  readonly id: "github";
  verify: Channel["verify"];
  parse: Channel["parse"];
  eventSelector: Channel["eventSelector"];
  threadSelector: Channel["threadSelector"];
  thread: Channel["thread"];
  messages: Channel["messages"];
  reply: Channel["reply"];
  acknowledge: Channel["acknowledge"];
  validate: AccessProvider["validate"];
  mint: AccessProvider["mint"];
  install: AccessProvider["install"];
  read: Deployable<{ id: number; slug: string }>["read"];
  diff: Deployable<{ id: number; slug: string }>["diff"];
  apply: Deployable<{ id: number; slug: string }>["apply"];
}

/** Access to a repo through an App: this repo by default, or another. */
export declare class RepoPolicy extends Policy {
  constructor(name: string, inputs: { app: GitHubApp; repo?: string; permissions: Permissions });
}

// ─── Railway ─────────────────────────────────────────────────────────────────

type ProjectInputs = { project: string; workspace?: string };

export declare class RailwayRouterHost implements RouterHost {
  constructor(inputs: ProjectInputs);
  ensure: RouterHost["ensure"];
  setSecret: RouterHost["setSecret"];
}

export declare class RailwayContainerHost implements ContainerHost {
  constructor(inputs: ProjectInputs & { sleep?: boolean });
  ensure: ContainerHost["ensure"];
  state: ContainerHost["state"];
  reach: ContainerHost["reach"];
  shell: ContainerHost["shell"];
  delete: ContainerHost["delete"];
}

// ─── Claude ──────────────────────────────────────────────────────────────────

type ClaudeConfig = {
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  systemPrompt?: string;                  // a path under .achq/; achq's runner prompt is always added
  prompts?: { new?: string; resume?: string };
  settings?: { [key: string]: Data };     // written to the agent's own settings.json
  instructions?: string;                  // a path, written as the agent's CLAUDE.md
};

export declare class Claude extends Resource<ClaudeConfig> implements Agent {
  sessionKey: Agent["sessionKey"];
  configure: Agent["configure"];
  run: Agent["run"];
  resumeCommand: Agent["resumeCommand"];
}
