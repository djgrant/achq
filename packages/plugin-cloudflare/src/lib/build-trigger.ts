import { ACHQ_SOURCE, BrowserActionNeeded, type Change, type Context, hasUnknown, type Inputs, known, ManagedResource, type Planned, type ResourceOptions, UNKNOWN } from "@achq/core";
import { CloudflareError, type Trigger, type TriggerSettings } from "@achq/utils/cloudflare";
import { connect } from "./cloudflare.ts";
import { BUILDS_GITHUB_APP, BUILDS_GITHUB_APP_INSTALL_URL, REPO_UNSEEN } from "./constants.ts";
import type { RepoIds } from "./repo-ids.ts";
import { packed, type WorkerConfig } from "./wrangler.ts";

type Props = {
  worker: string;
  /** The Worker's tag, which the trigger builds. Unknown until it exists. */
  tag: string;
  repo: string;
  branch: string;
  buildToken: string;
  /** The container Worker's config, which the build writes beside the repo's own files. */
  config: WorkerConfig;
  /** The achq commit whose Worker the build deploys. */
  ref: string;
};

/** `stale`: triggers on the Worker for another repo. */
type State = { trigger?: Trigger; variables: Record<string, string | null>; stale: string[] };
type Outputs = { trigger: string };

type TriggerChange = { kind: "create" } | { kind: "settings"; fields: string[] } | { kind: "variables"; names: string[] };

/** Where the build puts the achq Worker, and its config: names the repo's own files are unlikely to have. */
const WORKER_DIR = ".achq-worker";
const CONFIG_FILE = ".achq-wrangler.json";

/** The Worker at ACHQ_REF, from achq's archive as the router's start command gets achq, and the config from its variable. */
const BUILD_COMMAND = [
  `mkdir -p ${WORKER_DIR}`,
  `curl -fsSL "${ACHQ_SOURCE.archive}$ACHQ_REF" | tar -xz --strip-components=4 -C ${WORKER_DIR} --wildcards '*/packages/plugin-cloudflare/worker/*'`,
  `echo "$ACHQ_WRANGLER_CONFIG" | base64 -d | gunzip > ${CONFIG_FILE}`,
].join(" && ");

/** Not exactly `npx wrangler deploy`, which has Workers Builds open pull requests on the repo to set Wrangler up. */
const DEPLOY_COMMAND = `npx -y wrangler@4 deploy --config ${CONFIG_FILE}`;

/** Pushes match no path, so they don't build: the deployer starts builds itself. */
const NEVER = { path_includes: ["achq-never-matches/**"], path_excludes: ["*"] };

/** Where the container Worker's build finds its config's entry, relative to the config. */
export const CONTAINER_MAIN = `${WORKER_DIR}/index.ts`;

/** The trigger's variables, as Builds takes them. */
const variablesOf = ({ config, ref }: Props) => ({ ACHQ_WRANGLER_CONFIG: packed(JSON.stringify(config)), ACHQ_REF: ref });

/** A Builds variable holds at most 5 KB. */
const MAX_VARIABLE_BYTES = 5 * 1024;

const settingsOf = ({ branch, buildToken }: Props): TriggerSettings => ({
  trigger_name: "achq",
  build_token_uuid: buildToken,
  build_command: BUILD_COMMAND,
  deploy_command: DEPLOY_COMMAND,
  root_directory: "/",
  branch_includes: [branch],
  branch_excludes: [],
  ...NEVER,
  build_caching_enabled: true,
});

const sameRepo = (trigger: Trigger, repo: string) => {
  const connected = trigger.repo_connection;
  return !connected || `${connected.provider_account_name}/${connected.repo_name}`.toLowerCase() === repo.toLowerCase();
};

/**
 * A container Worker's Workers Builds trigger: it builds the repo's Dockerfile
 * into the achq Worker's container on `branch`, and deploys it. It's only
 * started by the deployer. A trigger on another repo is replaced: a trigger's
 * repo can't be changed.
 */
export class BuildTrigger extends ManagedResource<Props, State, Outputs, TriggerChange> {
  readonly kind = "cloudflare-build-trigger";

  constructor(
    name: string,
    props: Inputs<Props>,
    options: ResourceOptions,
    private readonly repoIds: RepoIds,
  ) {
    super(name, props, options);
  }

  async read({ tag, repo }: Props, ctx: Context) {
    if (!known(tag)) return undefined;
    const cf = await connect(ctx.env);
    const triggers = await cf.builds.triggers(tag);
    const trigger = triggers.find((t) => sameRepo(t, repo));
    const stale = triggers.filter((t) => t !== trigger).map((t) => t.trigger_uuid);
    if (!trigger) return { variables: {}, stale };
    const variables = Object.fromEntries(Object.entries(await cf.builds.variables(trigger.trigger_uuid)).map(([name, v]) => [name, v.value]));
    return { trigger, variables, stale };
  }

  diff(props: Props, current: State | undefined): TriggerChange[] {
    if (!current?.trigger) return [{ kind: "create" }];
    const want = settingsOf(props);
    const fields = (Object.keys(want) as (keyof TriggerSettings)[]).filter((key) => JSON.stringify(want[key]) !== JSON.stringify(current.trigger![key]));
    const variables = hasUnknown(props.config) ? { ACHQ_WRANGLER_CONFIG: "" } : variablesOf(props);
    const names = Object.entries(variables).filter(([name, value]) => current.variables[name] !== value).map(([name]) => name);
    return [...(fields.length ? [{ kind: "settings", fields } as const] : []), ...(names.length ? [{ kind: "variables", names } as const] : [])];
  }

  describe(change: TriggerChange, { worker, repo, branch }: Props): Change {
    switch (change.kind) {
      case "create":
        return { op: "+", target: worker, what: "build trigger", detail: `${repo}@${branch}` };
      case "settings":
        return { op: "~", target: worker, what: "build trigger", detail: change.fields.join(", ") };
      case "variables":
        return { op: "~", target: worker, what: "build variables", names: change.names };
    }
  }

  planned(_: Props, current: State | undefined): Planned<Outputs> {
    return { trigger: current?.trigger?.trigger_uuid ?? UNKNOWN };
  }

  async apply(props: Props, current: State | undefined, changes: TriggerChange[], ctx: Context) {
    const cf = await connect(ctx.env);
    const variables = variablesOf(props);
    for (const [name, value] of Object.entries(variables)) {
      if (value.length > MAX_VARIABLE_BYTES) throw new Error(`${props.worker}'s ${name} is ${value.length} bytes; Workers Builds takes at most ${MAX_VARIABLE_BYTES}`);
    }
    let trigger = current?.trigger?.trigger_uuid;
    for (const change of changes) {
      if (change.kind === "create") {
        for (const stale of current?.stale ?? []) await cf.builds.deleteTrigger(stale);
        const connection = await cf.builds.connect(await this.repoIds(props.repo)).catch((error) => {
          throw unseen(error) ? cantSee(props.repo, error) : error;
        });
        trigger = (await cf.builds.createTrigger(props.tag, connection, settingsOf(props))).trigger_uuid;
        await cf.builds.setVariables(trigger, varsFor(variables));
      } else if (change.kind === "settings") await cf.builds.updateTrigger(trigger!, settingsOf(props));
      else await cf.builds.setVariables(trigger!, varsFor(variables));
    }
    return { trigger: trigger! };
  }
}

/** Whether Workers Builds couldn't connect a repo because its GitHub App can't see it. */
const unseen = (error: unknown) => error instanceof CloudflareError && (error.codes.includes(REPO_UNSEEN) || error.status === 404);

/** Only Cloudflare can tell that its App can't see a repo, and only you can install it there. */
const cantSee = (repo: string, error: CloudflareError) =>
  new BrowserActionNeeded(`Workers Builds can't see ${repo}: install Cloudflare's GitHub App (${BUILDS_GITHUB_APP}) on it, then deploy again. ${error.message}`, {
    url: BUILDS_GITHUB_APP_INSTALL_URL,
    what: `install ${BUILDS_GITHUB_APP} on ${repo}`,
  });

const varsFor = (variables: Record<string, string>) => Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, { value, is_secret: false }]));
