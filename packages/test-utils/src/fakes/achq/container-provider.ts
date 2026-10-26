import type { ContainerProvider, ContainerSpec } from "@achq/core";

export class MemoryContainerProvider implements ContainerProvider {
  readonly services = new Map<string, { spec: ContainerSpec; builds: number }>();
  readonly calls: { op: "ensure" | "build" | "remove"; repo: string; name: string }[] = [];

  private id = (repo: string, name: string) => `${repo.toLowerCase()}/${name}`;

  /** Containers that exist without the deployer having made them in this test, e.g. from an earlier run. */
  seed(repo: string, name: string) {
    this.services.set(this.id(repo, name), { spec: { repo, identity: { id: "1", name: repo.split("/")[1]!, owner: { id: "1", name: repo.split("/")[0]! } }, name, dockerfile: ".achq/Dockerfile", branch: "main", env: {} }, builds: 1 });
  }

  ops(op?: "ensure" | "build" | "remove") {
    return this.calls.filter((c) => !op || c.op === op);
  }

  async ensure(spec: ContainerSpec, { build }: { build: boolean }) {
    this.calls.push({ op: "ensure", repo: spec.repo, name: spec.name });
    const existing = this.services.get(this.id(spec.repo, spec.name));
    this.services.set(this.id(spec.repo, spec.name), { spec, builds: (existing?.builds ?? 0) + (build ? 1 : 0) });
    if (build) this.calls.push({ op: "build", repo: spec.repo, name: spec.name });
    return { url: `http://${spec.name}.${spec.repo.replace("/", "-").toLowerCase()}.internal:3000` };
  }
  async list() {
    return [...this.services.values()].map(({ spec }) => ({ repo: spec.repo, name: spec.name }));
  }
  async remove(repo: string, name: string) {
    this.calls.push({ op: "remove", repo, name });
    this.services.delete(this.id(repo, name));
  }
  async shell(repo: string, name: string, command: string[], tty: boolean) {
    return { argv: ["memory-ssh", ...(tty ? ["-t"] : []), this.id(repo, name), ...command], requires: [] };
  }
}
