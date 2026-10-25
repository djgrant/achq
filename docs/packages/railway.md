# `@achq/railway`

`@achq/railway` runs ACHQ (`Router` and `Deployer`) and repository outposts inside a shared Railway project with persistent `/data` volumes and private networking. Re-exported as `railway` from `achq/infra`.

## Router & Deployer

Provision the control plane and outpost builder in a Railway project:

```ts [achq.infra.ts]
import { achq, railway } from "achq/infra";

export default achq(() => {
  const router = new railway.Router("router", {
    project: "acme-agents", // <-- Railway project name
  });

  new railway.Deployer("deployer", {
    router,
    owners: ["acme"],
  });
});
```

| Resource | Railway resources provisioned |
| --- | --- |
| `railway.Router` | `acme-agents` Railway project + public `achq-router` service with `/data` volume and webhook domain |
| `railway.Deployer` | Private, scale-to-zero `achq-deployer` service inside `acme-agents` |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RAILWAY_API_TOKEN` | Authenticates `achq infra` and `railway.Deployer` to manage outpost services |
