# `@achq/cloudflare`

`@achq/cloudflare` runs ACHQ (`Router` and `Deployer`) and repository outposts on Cloudflare Workers and Durable Object Containers. Imported in `achq.infra.ts` from `@achq/cloudflare/infra`.

```sh
pnpm add -D @achq/cloudflare
```

## Router & Deployer

Provision the control plane and outpost builder on Cloudflare:

```ts [achq.infra.ts]
import { achq } from "@achq/core";
import * as cloudflare from "@achq/cloudflare/infra";

export default achq(() => {
  const router = new cloudflare.Router("router", {
    project: "acme-agents", // <-- prefixes Worker names, KV namespace, and R2 bucket
  });

  new cloudflare.Deployer("deployer", {
    router,
    owners: ["acme"],
    sshKeys: ["ssh-ed25519 AAAA... me@laptop"], // <-- authorized_keys for outpost containers
  });
});
```

| Resource | Cloudflare resources provisioned |
| --- | --- |
| `cloudflare.Router` | KV namespace (`acme-agents`), R2 bucket (`acme-agents`), and always-on `acme-agents-router` Worker + `standard-1` DO container |
| `cloudflare.Deployer` | Scale-to-zero `acme-agents-deployer` Worker (10m idle timeout) + `ACHQ_CLOUDFLARE_DEPLOYER_TOKEN` Worker secret |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Optional CI alternative to `npx wrangler login` |
| `CLOUDFLARE_ACCOUNT_ID` | Selects target account when login has access to multiple accounts |
