import type { RepoManifest } from "../resources/repo-manifest.ts";
import type { ManagedResource } from "../resources/resource.ts";
import type { Installation } from "../wire/protocol.ts";

/** Subscribes repos to a channel's sources, and lists the repos each source is installed on. */
export interface InstallationProvider {
  /** The channel whose sources it installs. */
  readonly id: string;

  // ── The CLI, acting as you, for `achq install` and `uninstall` ──
  /**
   * What makes `repo` subscribe to the sources its config names (`installed`),
   * or leave them: one resource per source, named after it. Pure: the
   * resources read and change things as you when they're planned and applied.
   * They become what `installations()` lists.
   */
  installation(repo: string, manifest: RepoManifest, installed: boolean): ManagedResource[];

  // ── Router side, holding the channel's secrets ──
  /** The repos each source is installed on, and the code host they're on: what the deployer serves. */
  installations(): Promise<Installation[]>;
}
