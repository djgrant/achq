# Installation

## CLI

Install the `achq` CLI globally from npm:

```bash
@pm.add("-g @achq/cli")
```

The CLI runs on [Bun](https://bun.sh), which must be on your `PATH`.

## Packages

Add the packages your config imports as dev dependencies, for type-checking and editor support.

In an infrastructure repository, add `@achq/core` and the plugins `achq.infra.ts` declares resources from:

```bash
@pm.dev("@achq/core @achq/cloudflare @achq/github @achq/claude")  # or @achq/railway
```

In an outpost repository, add `@achq/core` and the plugins `.achq/config.ts` imports:

```bash
@pm.dev("@achq/core @achq/github @achq/claude")
```

| Package | Imported in | As |
| --- | --- | --- |
| [`@achq/core`](../packages/core.md) | Both | `import { achq, Container, Workspace, Trigger } from "@achq/core"` |
| [`@achq/cloudflare`](../packages/cloudflare.md) | `achq.infra.ts` | `import * as cloudflare from "@achq/cloudflare/infra"` |
| [`@achq/railway`](../packages/railway.md) | `achq.infra.ts` | `import * as railway from "@achq/railway/infra"` |
| [`@achq/github`](../packages/github.md) | Both | `"@achq/github/infra"` in `achq.infra.ts`, `"@achq/github"` in `.achq/config.ts` |
| [`@achq/claude`](../packages/claude.md) | Both | `"@achq/claude/infra"` in `achq.infra.ts`, `"@achq/claude"` in `.achq/config.ts` |

The versions installed in the infrastructure repository are the versions that run. `achq infra up` imports `achq.infra.ts` as any module, so its imports resolve to what the repository installed, and each resource it declares carries its package's name and version. The router, deployer and containers install those packages from npm when they start. `achq infra up` checks first that each is published, and that it works with the version of `@achq/core` installed beside it, which the router and deployer run.

A plugin that isn't achq's own is installed the same way: add it to the infrastructure repository and declare a resource from it.

The deployer evaluates `.achq/config.ts` in a sandbox that allows `@achq/core`, the plugins the infrastructure installs in containers (its channels', policies' and runtimes'), and files inside `.achq/`.

## Provider CLIs

| CLI | Needed for | Login |
| --- | --- | --- |
| `gh` | GitHub repos | `gh auth login` |
| `claude` | `@achq/claude` token | `claude setup-token` |
| `npx wrangler@4` | Cloudflare HQs | `npx wrangler login` |
| `railway` | Railway HQs | `railway login` |
| `op` | 1Password vaults *(optional)* | `op signin` |
