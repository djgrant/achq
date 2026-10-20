export type ContainerSpec = {
  /** The `CodeHostProvider` the repo is on. */
  host: string;
  repo: string;
  name: string;
  /** Dockerfile path in the repo, e.g. `.achq/Dockerfile`. */
  dockerfile: string;
  branch: string;
  /**
   * The variables achq defines. The provider adds its own: PORT, and DATA_DIR since it owns the volume's mount path.
   * The provider may read ACHQ_ROUTER_URL (to keep the container awake) and ACHQ_REPO / ACHQ_CONTAINER (to list containers); these match `repo` and `name`.
   */
  env: Record<string, string>;
};

export interface ContainerProvider {
  /** Creates or updates the container's service and volume. Doesn't build. Returns the URL the router reaches it on. */
  ensure(spec: ContainerSpec): Promise<{ url: string }>;
  /** Builds and deploys the container from the head of its branch. */
  deploy(repo: string, name: string): Promise<void>;
  list(): Promise<{ repo: string; name: string }[]>;
  /** Deletes the service and its volume. Only `achq infra up --prune` calls this. */
  remove(repo: string, name: string): Promise<void>;
  /** Where to find it, for the repo CLI (`ssh`, `resume`). Not secret. */
  locate(repo: string, name: string): Promise<Record<string, string>>;
}

/** A container at a location its provider's `locate` gave, for `achq container ssh` and `achq container resume`. */
export interface ContainerShell {
  /** Whether the location has what `open` and `run` need. */
  reachable(location: Record<string, string>): boolean;
  /** A shell in the container, interactive or running `command`. Returns the exit code. */
  open(location: Record<string, string>, command: string[]): Promise<number>;
  run(location: Record<string, string>, command: string[]): Promise<string>;
}
