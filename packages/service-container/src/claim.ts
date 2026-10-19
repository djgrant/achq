import { type Channel, type ChannelEvent, type ClaimRequest, type RepoManifest, type Thread, threadKey } from "@achq/core";
import { signedFetch } from "@achq/core/signing";
import type { Paths } from "./paths.ts";
import { readState, type ThreadState, writeState } from "./state.ts";

type Workspace = RepoManifest["workspaces"][number];

export type ClaimOptions = {
  paths: Paths;
  repo: string;
  container: string;
  routerUrl: string;
  containerSecret: string;
  log: (line: string) => void;
};

/**
 * The workspace that claimed the thread, or the first of this container's that
 * matches it now. A new claim is recorded on the volume and told to the router.
 */
export const claimThread = (opts: ClaimOptions, channel: Channel, event: ChannelEvent, thread: Thread, workspaces: Workspace[]): ThreadState | undefined => {
  const file = opts.paths.thread(threadKey(thread.ref));
  const existing = readState(file);
  if (existing && workspaces.some((w) => w.name === existing.workspace)) return existing;
  const workspace = workspaces.find((w) => channel.matchThread(w.threads, { ref: thread.ref, labels: thread.labels }));
  if (!workspace) return undefined;
  const state: ThreadState = { thread: thread.ref, source: event.source, number: thread.vars.number, workspace: workspace.name, sessions: {} };
  writeState(file, state);
  const claim: ClaimRequest = { repo: opts.repo, container: opts.container, workspace: workspace.name, thread: thread.ref };
  signedFetch(opts.containerSecret, `${opts.routerUrl}/claims`, { method: "POST", body: JSON.stringify(claim) })
    .then((res) => res.ok || opts.log(`claim not recorded: ${res.status}`))
    .catch((e) => opts.log(`claim not recorded: ${e}`));
  return state;
};
