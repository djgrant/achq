/** Something only a person can do, in their browser: `what`, e.g. "install cloudflare-workers-and-pages on acme/widgets", at `url`. */
export type BrowserAction = { url: string; what: string };

/**
 * A failure only a person can fix, in their browser, e.g. a vendor's GitHub
 * App that isn't installed on the repo. Any provider can throw it: the deployer
 * carries its action in the repo's status, and `achq repo install` opens it,
 * waits for you, and deploys again.
 */
export class BrowserActionNeeded extends Error {
  constructor(
    message: string,
    readonly action: BrowserAction,
  ) {
    super(message);
  }
}
