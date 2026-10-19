import type { RepoManifest } from "../resources/repo-manifest.ts";
import type { ManagedResource } from "../resources/resource.ts";

/** Subscribes a repo to a channel's sources, for `achq install` and `uninstall`. The CLI uses it, acting as you. */
export interface Installer {
  /** The channel whose sources it installs. */
  readonly id: string;
  /**
   * What makes `repo` subscribe to the sources its config names (`installed`),
   * or leave them: one resource per source, named after it. Pure: the
   * resources read and change things as you when they're planned and applied.
   * They become what the channel's `installations()` lists.
   */
  installation(repo: string, manifest: RepoManifest, installed: boolean): ManagedResource[];
}
