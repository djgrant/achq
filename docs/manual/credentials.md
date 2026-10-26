# Secrets & Vaults

Keep operator secrets and generated channel keys out of plaintext files:

```ts [achq.config.ts]
import * as onepassword from "@achq/1password";

export default {
  env: "op run --env-file=.env --",       // <-- 1. loads CLI env vars once at startup
  vault: onepassword.vault("acme-ops"),   // <-- 2. stores generated channel private keys
};
```

An optional `achq.config.ts` beside `achq.infra.ts` configures how `achq infra up` loads environment variables and where it stores generated channel credentials.

## Environment variables

| Plugin | Variable | Purpose |
| --- | --- | --- |
| `@achq/claude` | `CLAUDE_CODE_OAUTH_TOKEN` | Authenticates Claude Code inside outposts (`claude setup-token`) |
| `@achq/railway` | `RAILWAY_API_TOKEN` | Authenticates `achq infra` and `railway.Deployer` |
| `@achq/cloudflare` | `CLOUDFLARE_API_TOKEN` | Optional CI alternative to `npx wrangler login` |
| `@achq/cloudflare` | `CLOUDFLARE_ACCOUNT_ID` | Selects account when login spans multiple Cloudflare accounts |

Setting `env` in `achq.config.ts` runs the command once to populate `process.env` while keeping your interactive terminal attached.

## Vaults

A channel platform returns its private key only once when created (for example, when `github.Channel` creates a GitHub App). Configuring a `vault` stores that key in 1Password instead of only on the running `Router`:

| Without `vault` | With `vault` |
| --- | --- |
| Key lives only on the running `Router` | Key is saved to the vault first, then synced to `Router` |
| Switching cloud providers strands the channel | Switching cloud providers restores the key from the vault |
| Only the live `Router` holds the key | Any teammate with vault access can run `achq infra up` |
