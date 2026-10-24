import { type Context, CreateOnlyResource, type Planned, UNKNOWN } from "@achq/core";
import { connect } from "./cloudflare.ts";
import { COMPATIBILITY } from "../../worker/settings.ts";
import { publicUrl } from "./names.ts";

type Props = { name: string; workersDev: string };

type State = { tag: string };

/** `tag` is what a Builds trigger names it by. */
type Outputs = { tag: string; url: string };

/** What a Worker answers before its first deploy. */
const PLACEHOLDER = `export default { fetch: () => new Response("achq: not deployed yet\\n", { status: 503 }) };\n`;

/**
 * A Worker, made as a placeholder until it's deployed: a Builds trigger needs
 * the Worker to exist, and a service's variables are set before its first
 * deploy. Its URL is known before it exists.
 */
export class Worker extends CreateOnlyResource<Props, State, Outputs> {
  readonly kind = "cloudflare-worker";
  readonly what = "worker";

  async read({ name }: Props, ctx: Context) {
    const found = await (await connect(ctx.env)).workers.get(name);
    return found ? { tag: found.id } : undefined;
  }

  planned({ name, workersDev }: Props, current: State | undefined): Planned<Outputs> {
    return { tag: current?.tag ?? UNKNOWN, url: publicUrl(name, workersDev) };
  }

  async apply({ name, workersDev }: Props, _current: State | undefined, _changes: "create"[], ctx: Context) {
    const cf = await connect(ctx.env);
    await cf.workers.upload(name, PLACEHOLDER, COMPATIBILITY.date);
    const made = await cf.workers.get(name);
    if (!made) throw new Error(`Cloudflare didn't make Worker ${name}`);
    return { tag: made.id, url: publicUrl(name, workersDev) };
  }

  /** Its container application, then the Worker, and its Durable Object with it. */
  async destroy({ name }: Props, _current: State, ctx: Context) {
    const cf = await connect(ctx.env);
    const application = await cf.containers.application(name);
    if (application) await cf.containers.deleteApplication(application.id);
    await cf.workers.delete(name);
  }
}
