import { type Change, type Context, hasUnknown, known, ManagedResource, type Planned, UNKNOWN } from "@achq/core";
import { collections } from "@achq/utils/collections";
import { crypto } from "@achq/utils/crypto";
import { cloudflareFromEnv } from "./cloudflare.ts";
import { KV_KEYS } from "./names.ts";

type Props = {
  namespaceId: string;
  worker: string;
  /** Set once the Worker exists. */
  tag: string;
  secrets: Record<string, string>;
};
type State = { set?: string };
type Outputs = { fingerprint: string };

const FINGERPRINT_CHARS = 16;

/** Secrets can't be read back, so a hash of what they were last set to is kept in the namespace. */
const fingerprint = (secrets: Record<string, string>) => crypto.sha256Hex(JSON.stringify(collections.sortKeys(secrets)), FINGERPRINT_CHARS);

/**
 * A container Worker's secrets: its container's variables, and the internal
 * key. Its builds keep them: Wrangler deploys over a Worker's secrets without
 * touching them. Its container gets them when it next starts.
 */
export class Secrets extends ManagedResource<Props, State, Outputs, "set"> {
  readonly kind = "cloudflare-secrets";

  async read({ namespaceId, worker, tag }: Props, ctx: Context) {
    if (!known(namespaceId) || !known(tag)) return undefined;
    return { set: await cloudflareFromEnv(ctx.env).kv.get(namespaceId, KV_KEYS.deployed(worker)) };
  }

  diff({ secrets }: Props, current: State | undefined): "set"[] {
    return hasUnknown(secrets) || current?.set !== fingerprint(secrets) ? ["set"] : [];
  }

  describe(_: "set", { worker, secrets }: Props): Change {
    return { op: "~", target: worker, what: "secrets", names: Object.keys(secrets) };
  }

  planned({ secrets }: Props): Planned<Outputs> {
    return { fingerprint: hasUnknown(secrets) ? UNKNOWN : fingerprint(secrets) };
  }

  async apply({ namespaceId, worker, secrets }: Props, _current: State | undefined, _changes: "set"[], ctx: Context) {
    const cf = cloudflareFromEnv(ctx.env);
    for (const [name, value] of Object.entries(secrets)) await cf.workers.putSecret(worker, name, value);
    const set = fingerprint(secrets);
    await cf.kv.put(namespaceId, KV_KEYS.deployed(worker), set);
    return { fingerprint: set };
  }
}
