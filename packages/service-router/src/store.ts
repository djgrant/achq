// The router's volume: a directory of JSON files for each kind of state, so it
// survives a restart. createJsonDirStore keeps a crash from leaving half a file.
import { join } from "node:path";
import type { RouterRepoConfig } from "@achq/core";
import { createJsonDirStore } from "@achq/utils/fs";
import type { FailedEntry, InboxEntry } from "./inbox.ts";
import type { Claims } from "./targets.ts";

/** Repo names are case-insensitive, so state is kept by the lowercased name. */
export const repoKey = (repo: string) => repo.toLowerCase();

/** `owner/repo` as a file name. */
export const repoFile = (repo: string) => repoKey(repo).replace("/", "__");

/** The repo key a `repoFile` name stands for. */
export const repoFromFile = (name: string) => name.replace("__", "/");

export const createStore = (root: string) => ({
  /** Each repo's router config, by `repoFile`. */
  repos: createJsonDirStore<RouterRepoConfig>(join(root, "repos")),
  /** Each repo's claims, by `repoFile`. */
  claims: createJsonDirStore<Claims>(join(root, "claims")),
  /** Accepted deliveries some target hasn't answered yet, by delivery ID. */
  inbox: createJsonDirStore<InboxEntry>(join(root, "inbox")),
  /** Deliveries some target never answered, by delivery ID. */
  failed: createJsonDirStore<FailedEntry>(join(root, "failed")),
});

export type Store = ReturnType<typeof createStore>;
