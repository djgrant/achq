import { type Cloudflare, CloudflareError } from "@achq/utils/cloudflare";
import { DEPLOYER_TOKEN_NAME } from "./constants.ts";

/** The deployer's own token's id, the Builds token registered for it if there is one, and the account's Builds tokens. Changes nothing. */
export const registered = async (cf: Cloudflare) => {
  const { id } = await cf.verifyToken();
  const tokens = await cf.builds.tokens();
  return { id, own: tokens.find((t) => t.cloudflare_token_id === id)?.build_token_uuid, tokens };
};

/**
 * The Workers Builds token the deployer builds containers with: its own API
 * token, `secret`, registered with Builds by its id, which only that token
 * can say. One registered already is kept. If Builds won't register it, the
 * account's newest token is taken, e.g. one made in the dashboard (Builds
 * can't say whether it still works); with none, it throws saying where to
 * make one. `worker` is a container's Worker, whose settings page makes one.
 */
export const buildToken = async (cf: Cloudflare, secret: string, worker: string, log: (line: string) => void) => {
  const { id, own, tokens } = await registered(cf);
  if (own) return own;
  try {
    return (await cf.builds.registerToken(DEPLOYER_TOKEN_NAME, secret, id)).build_token_uuid;
  } catch (e) {
    if (!(e instanceof CloudflareError)) throw e;
    const newest = tokens.at(-1);
    const dashboard = `https://dash.cloudflare.com/${cf.accountId}/workers/services/view/${worker}/production/settings`;
    if (!newest) {
      throw new Error(
        `Workers Builds wouldn't take the deployer's token (${e.message}), and the account has no other. Make one at ${dashboard}: under Build, connect a repository and choose "Create new token"; you needn't save the connection.`,
      );
    }
    log(`Workers Builds wouldn't take the deployer's token (${e.message}); building with ${newest.build_token_name}`);
    return newest.build_token_uuid;
  }
};
