import { join } from "node:path";
import { repoName, type RouterRepoConfig } from "@achq/core";
import { JsonDirStore } from "@achq/utils/disk";
import type { FailedEntry, InboxEntry } from "./inbox.ts";
import type { Claims } from "./targets.ts";


export const repoFile = (repo: string) => repoName.key(repo).replace("/", "__");

export const repoFromFile = (name: string) => name.replace("__", "/");

export const createStore = (root: string) => ({
  repos: new JsonDirStore<RouterRepoConfig>(join(root, "repos")),
  claims: new JsonDirStore<Claims>(join(root, "claims")),
  /** Accepted deliveries some target hasn't answered yet, by delivery ID. */
  inbox: new JsonDirStore<InboxEntry>(join(root, "inbox")),
  /** Deliveries some target never answered, by delivery ID. */
  failed: new JsonDirStore<FailedEntry>(join(root, "failed")),
});

export type Store = ReturnType<typeof createStore>;
