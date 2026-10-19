export type ContainerSpec = {
  /** The `RepoHost` the repo is on. */
  host: string;
  repo: string;
  name: string;
  /** Dockerfile path in the repo, e.g. `.achq/Dockerfile`. */
  dockerfile: string;
  branch: string;
  /** The variables achq defines. The host adds only its own (e.g. PORT). */
  env: Record<string, string>;
};

/** Where containers run. */
export interface ContainerHost {
  /** Creates or updates the container's service and volume. Doesn't build. Returns the URL the router reaches it on. */
  ensure(spec: ContainerSpec): Promise<{ url: string }>;
  /** Builds and deploys the container from the head of its branch. */
  deploy(repo: string, name: string): Promise<void>;
  list(): Promise<{ repo: string; name: string }[]>;
  /** Deletes the service and its volume. Only `achq up --prune` calls this. */
  remove(repo: string, name: string): Promise<void>;
  /** Where to find it, for the repo CLI (`ssh`, `resume`). Not secret. */
  locate(repo: string, name: string): Promise<Record<string, string>>;
}

/** A container at a location its host's `locate` gave, for `achq ssh` and `achq resume`. */
export interface ContainerShell {
  /** Whether the location has what `open` and `run` need. */
  reachable(location: Record<string, string>): boolean;
  /** A shell in the container, interactive or running `command`. Returns the exit code. */
  open(location: Record<string, string>, command: string[]): Promise<number>;
  /** Runs `command` in the container and returns its stdout. */
  run(location: Record<string, string>, command: string[]): Promise<string>;
}
