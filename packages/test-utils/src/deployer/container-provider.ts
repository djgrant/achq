import type { ContainerProvider, ContainerSpec } from "@achq/core";

export class MemoryContainerProvider implements ContainerProvider {
  readonly services = new Map<string, { spec: ContainerSpec; builds: number }>();
  readonly calls: { op: "ensure" | "deploy" | "remove"; repo: string; name: string }[] = [];

  private id = (repo: string, name: string) => `${repo.toLowerCase()}/${name}`;

  /** Containers that exist without the deployer having made them in this test, e.g. from an earlier run. */
  seed(repo: string, name: string) {
    this.services.set(this.id(repo, name), { spec: { host: "github", repo, name, dockerfile: ".achq/Dockerfile", branch: "main", env: {} }, builds: 1 });
  }

  ops(op?: "ensure" | "deploy" | "remove") {
    return this.calls.filter((c) => !op || c.op === op);
  }

  async ensure(spec: ContainerSpec) {
    this.calls.push({ op: "ensure", repo: spec.repo, name: spec.name });
    const existing = this.services.get(this.id(spec.repo, spec.name));
    this.services.set(this.id(spec.repo, spec.name), { spec, builds: existing?.builds ?? 0 });
    return { url: `http://${spec.name}.${spec.repo.replace("/", "-").toLowerCase()}.internal:3000` };
  }
  async deploy(repo: string, name: string) {
    this.calls.push({ op: "deploy", repo, name });
    const s = this.services.get(this.id(repo, name));
    if (!s) throw new Error(`no service ${repo}/${name}`);
    s.builds++;
  }
  async list() {
    return [...this.services.values()].map(({ spec }) => ({ repo: spec.repo, name: spec.name }));
  }
  async remove(repo: string, name: string) {
    this.calls.push({ op: "remove", repo, name });
    this.services.delete(this.id(repo, name));
  }
  async locate(repo: string, name: string) {
    return { containerProvider: "memory", service: this.id(repo, name) };
  }
}
