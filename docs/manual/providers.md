# Container Providers

An ACHQ instance runs its `Router`, `Deployer`, and every outpost `Container` on a pluggable `ContainerProvider`. `.achq/config.ts` stays provider-agnostic, so you can switch providers in `achq.infra.ts` without touching subscriber repositories.

| Capability | Cloudflare (`@achq/cloudflare`) | Railway (`@achq/railway`) |
| --- | --- | --- |
| **Compute** | Worker + `standard-1` Durable Object container | Railway Service per router, deployer, and outpost |
| **Private network** | Authenticated Worker routing (`*.achq.internal`) | Railway private network (`*.railway.internal`) |
| **Service store** | Durable Object storage | JSON files on `/data` volume |
| **Outpost `/data` disk** | DO disk snapshots + R2 archive across image rebuilds | Railway persistent volume at `/data` |
| **Image builds** | Cloudflare Workers Builds | Railway GitHub builder |
| **Container SSH** | `wrangler containers ssh` (`sshKeys` on `Deployer`) | `railway ssh` (`railway login`) |

## Cloudflare

Run the control plane and outposts on Cloudflare Workers and Durable Object Containers:

```ts [achq.infra.ts]
const router = new cloudflare.Router("router", {
  project: "acme-agents",
});

new cloudflare.Deployer("deployer", {
  router,
  owners: ["acme"],
  sshKeys: ["ssh-ed25519 AAAA... dev@acme"], // <-- written to outpost authorized_keys for `achq container ssh`
});
```

| Credential | Used by | Setup |
| --- | --- | --- |
| **Local session** | `achq infra up` (KV, R2, Workers) | `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` in CI) |
| **Deployer token** | `cloudflare.Deployer` (Workers Builds) | Browser prompt on first `achq infra up` (rotate via `--rotate-deployer-token`) |

| `/data` lifecycle event | Snapshot mechanism |
| --- | --- |
| **Idle sleep (10m)** | Durable Object snapshots `/data` and restores it when woken (~1.5s) |
| **Dockerfile rebuild** | Archives previous `/data` snapshot to R2, extracts onto the new image, and re-snapshots |

## Railway

Run the control plane and outposts as services inside a Railway project:

```ts [achq.infra.ts]
const router = new railway.Router("router", {
  project: "acme-agents",
});

new railway.Deployer("deployer", {
  router,
  owners: ["acme"],
});
```

| Credential | Used by | Setup |
| --- | --- | --- |
| `RAILWAY_API_TOKEN` | `achq infra` + `railway.Deployer` | Export in environment or `achq.config.ts` |
| `railway login` | `achq container ssh` + `resume` | Local Railway CLI session |

## Builder access

Cloud providers build `.achq/Dockerfile` through their own GitHub App (**Cloudflare Workers and Pages** or **Railway App**):

```text
1. `achq repo install` ──► Deployer checks builder access to `acme/webapp`
2. Missing access      ──► Writes builder install URL to `ACHQ_STATUS`
3. Browser prompt      ──► Grant builder App access to `acme/webapp`
4. Auto-retry          ──► Deployer builds `.achq/Dockerfile`
```
