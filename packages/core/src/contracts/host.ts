export type ServiceState = "building" | "running" | "sleeping" | "failed" | "missing";

export type ContainerSpec = {
  repo: string;
  name: string;
  /** Dockerfile path in the repo, e.g. `.achq/Dockerfile`. */
  dockerfile: string;
  branch: string;
  env: Record<string, string>;
};

/** Where containers run. */
export interface ContainerHost {
  /** Creates or updates the container's service and volume. Doesn't build. Returns the URL the router reaches it on. */
  ensure(spec: ContainerSpec): Promise<{ url: string; service: string }>;
  /** Builds and deploys the container from the head of its branch. */
  deploy(repo: string, name: string): Promise<void>;
  state(repo: string, name: string): Promise<ServiceState>;
  list(): Promise<{ repo: string; name: string; service: string }[]>;
  /** Deletes the service and its volume. Only `achq up --prune` calls this. */
  remove(repo: string, name: string): Promise<void>;
  /** Where to find it, for the repo CLI (`ssh`, `resume`). Not secret. */
  locate(repo: string, name: string): Promise<Record<string, string>>;
}
