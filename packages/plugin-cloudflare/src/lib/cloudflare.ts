import type { Check } from "@achq/core";
import { implementationSecret } from "@achq/core/secrets";
import { CLOUDFLARE_API, Cloudflare, CloudflareError } from "@achq/utils/cloudflare";
import { Env, type Vars } from "@achq/utils/env";
import { subprocess } from "@achq/utils/subprocess";
import { CLOUDFLARE_ENV, CONTAINER_PROVIDER, DEPLOYER_TOKEN_NAME, DEPLOYER_TOKEN_PERMISSIONS, LOG_TAIL_LINES, WRANGLER, WRANGLER_TOKEN_REUSE_MS } from "./constants.ts";

/** Where your API tokens are made and deleted. */
export const TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";
const ACTIVE = "active";
const SIGN_IN = "npx wrangler login";

/** Wrangler, as `vars` runs it. */
export const wranglerCommand = (vars: Vars) => new Env(vars).optional(CLOUDFLARE_ENV.wrangler)?.split(" ") ?? WRANGLER;

/** Wrangler's OAuth token, by the command that printed it, until it's asked for again. */
const wranglerTokens = new Map<string, { token: Promise<string>; at: number }>();
/** The one account a token reaches, by its endpoint and token. */
const onlyAccounts = new Map<string, Promise<string>>();

/** Forgets what was asked of Wrangler and Cloudflare: for tests that sign in and out. */
export const forgetSignIn = () => {
  wranglerTokens.clear();
  onlyAccounts.clear();
};

/** What `wrangler auth token --json` prints: refreshed by Wrangler when it's expired. */
const askWrangler = async (command: string[]) => {
  const env = { ...process.env };
  // Its own sign-in, not a token: `connect` only asks it without one.
  delete env[CLOUDFLARE_ENV.token];
  const result = await subprocess.collect([...command, "auth", "token", "--json"], { env });
  if (!result.ok) throw new Error(`Wrangler isn't signed in to Cloudflare. Run \`${SIGN_IN}\`, or set ${CLOUDFLARE_ENV.token}:\n${subprocess.tail(result, LOG_TAIL_LINES)}`);
  const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as { type?: string; token?: string };
  if (!printed.token) throw new Error(`Wrangler gave no token (${printed.type ?? "nothing"}). Run \`${SIGN_IN}\`, or set ${CLOUDFLARE_ENV.token}`);
  return printed.token;
};

const wranglerToken = (vars: Vars) => {
  const command = wranglerCommand(vars);
  const key = command.join(" ");
  const cached = wranglerTokens.get(key);
  if (cached && Date.now() - cached.at < WRANGLER_TOKEN_REUSE_MS) return cached.token;
  const token = askWrangler(command);
  wranglerTokens.set(key, { token, at: Date.now() });
  token.catch(() => wranglerTokens.delete(key));
  return token;
};

const onlyAccount = (token: string, endpoint: string) => {
  const key = `${endpoint}\n${token}`;
  let found = onlyAccounts.get(key);
  if (!found) {
    found = Cloudflare.accounts(token, endpoint).then((accounts) => {
      if (accounts.length === 1) return accounts[0]!.id;
      const listed = accounts.map((a) => `${a.id} (${a.name})`).join(", ");
      throw new Error(accounts.length ? `You can reach ${accounts.length} Cloudflare accounts: ${listed}. Set ${CLOUDFLARE_ENV.accountId} to one.` : "You can reach no Cloudflare account.");
    });
    onlyAccounts.set(key, found);
    found.catch(() => onlyAccounts.delete(key));
  }
  return found;
};

/**
 * The account, as `vars` reaches it, at CLOUDFLARE_API_URL if that's set
 * (tests point it at a fake): with CLOUDFLARE_API_TOKEN if it's set, as in CI
 * or the deployer, or else Wrangler's OAuth sign-in. CLOUDFLARE_ACCOUNT_ID
 * names the account; without it, it's the only one the token reaches.
 */
export const connect = async (vars: Vars) => {
  const env = new Env(vars);
  const endpoint = env.optional(CLOUDFLARE_ENV.endpoint) ?? CLOUDFLARE_API;
  const token = env.optional(CLOUDFLARE_ENV.token) ?? (await wranglerToken(vars));
  const accountId = env.optional(CLOUDFLARE_ENV.accountId) ?? (await onlyAccount(token, endpoint));
  return new Cloudflare(token, accountId, endpoint);
};

/** That you're signed in to Cloudflare, with Wrangler or a token, and can read the account. */
export const tokenCheck = (vars: Vars): Check => ({
  label: "Cloudflare sign-in",
  check: async () => {
    const cf = await connect(vars);
    // An answer from Cloudflare says it turned the sign-in down; anything else, e.g. no network, says nothing about it.
    await cf.account().catch((e) => {
      throw e instanceof CloudflareError ? new CloudflareError(`Cloudflare won't show account ${cf.accountId} to your sign-in (${e.message})`, e.status) : e;
    });
  },
  remediation: [
    `Sign Wrangler in: ${SIGN_IN}`,
    `Or set ${CLOUDFLARE_ENV.token} to an API token that can read the account`,
    `Set ${CLOUDFLARE_ENV.accountId} if you can reach more than one account`,
  ],
});

/** The dashboard's create-token page, filled in with what the deployer's token can do on `accountId`. */
export const deployerTokenPage = (accountId: string) =>
  `${TOKENS_PAGE}?${new URLSearchParams({ permissionGroupKeys: JSON.stringify(DEPLOYER_TOKEN_PERMISSIONS), accountId, zoneId: "all", name: DEPLOYER_TOKEN_NAME })}`;

/** Why `token` won't do as the deployer's, or undefined if it will: Cloudflare takes it, as an API token, and it can read the account. */
export const deployerTokenProblem = async (token: string, accountId: string, endpoint: string) => {
  const cf = new Cloudflare(token, accountId, endpoint);
  try {
    const { status } = await cf.verifyToken();
    if (status !== ACTIVE) return `That token is ${status} on Cloudflare`;
    await cf.account();
    return undefined;
  } catch (e) {
    if (e instanceof CloudflareError) return `Cloudflare turned that token down (${e.message})`;
    throw e;
  }
};

/**
 * What achq's Workers prove themselves to each other with, from
 * AGENT_WEBHOOK_KEY: the CLI and the deployer each make it for the Workers
 * they deploy, and it never reaches a container.
 */
export const internalKey = (key: string) => implementationSecret(key, `${CONTAINER_PROVIDER}:internal`);

/** A Worker's secrets: its container's variables, as ACHQ_ENV, and its internal key, from AGENT_WEBHOOK_KEY. */
export const workerSecrets = (variables: Record<string, string>, key: string) => ({ ACHQ_ENV: JSON.stringify(variables), ACHQ_INTERNAL_KEY: internalKey(key) });
