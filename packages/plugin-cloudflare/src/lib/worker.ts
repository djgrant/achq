import { type Change, type Context, known, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { connect } from "./cloudflare.ts";
import { COMPATIBILITY } from "../../worker/settings.ts";
import { KV_KEYS, publicUrl } from "./names.ts";

type Props = {
  name: string;
  workersDev: string;
  /** Set to read its variables from the project's namespace, for a service's `env`. */
  env?: { namespaceId: string };
};

type State = { tag: string; env?: Record<string, string> };

/** `tag` is what a Builds trigger names it by. `env`, if asked for: its variables before this run changes them, none if it doesn't exist yet. */
type Outputs = { tag: string; url: string; env?: Record<string, string> };

/** What a Worker answers before its first deploy. */
const PLACEHOLDER = `export default { fetch: () => new Response("achq: not deployed yet\\n", { status: 503 }) };\n`;

/**
 * A Worker, made as a placeholder until it's deployed: a Builds trigger needs
 * the Worker to exist, and a service's variables are set before its first
 * deploy. Its URL is known before it exists.
 */
export class Worker extends ManagedResource<Props, State, Outputs, "create"> {
  readonly kind = "cloudflare-worker";

  async read({ name, env }: Props, ctx: Context) {
    const cf = await connect(ctx.env);
    const found = await cf.workers.get(name);
    if (!found) return undefined;
    if (!env) return { tag: found.id };
    const stored = known(env.namespaceId) ? await cf.kv.getJson<Record<string, string>>(env.namespaceId, KV_KEYS.service(name)) : undefined;
    return { tag: found.id, env: stored ?? {} };
  }

  diff(_: Props, current: State | undefined): "create"[] {
    return current ? [] : ["create"];
  }

  describe(_: "create", { name }: Props): Change {
    return { op: "+", target: name, what: "worker" };
  }

  planned({ name, workersDev, env }: Props, current: State | undefined): Planned<Outputs> {
    return { tag: current?.tag ?? UNKNOWN, url: publicUrl(name, workersDev), ...(env && { env: current?.env ?? {} }) };
  }

  async apply({ name, workersDev, env }: Props, _current: State | undefined, _changes: "create"[], ctx: Context) {
    const cf = await connect(ctx.env);
    await cf.workers.upload(name, PLACEHOLDER, COMPATIBILITY.date);
    const made = await cf.workers.get(name);
    if (!made) throw new Error(`Cloudflare didn't make Worker ${name}`);
    return { tag: made.id, url: publicUrl(name, workersDev), ...(env && { env: {} }) };
  }

  /** Its container application, then the Worker, and its Durable Object with it. */
  async destroy({ name }: Props, _current: State, ctx: Context) {
    const cf = await connect(ctx.env);
    const application = await cf.containers.application(name);
    if (application) await cf.containers.deleteApplication(application.id);
    await cf.workers.delete(name);
  }
}
