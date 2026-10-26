# Installation

## CLI

Install the `achq` CLI globally from npm:

```sh
bun add -g @achq/cli
```

The CLI runs on [Bun](https://bun.sh), which must be on your `PATH`.

## Packages

Add the packages your config imports as dev dependencies, for type-checking and editor support.

In an infrastructure repository, add `@achq/core` and the plugins `achq.infra.ts` declares resources from:

```sh
bun add -D @achq/core @achq/cloudflare @achq/github  # or @achq/railway
```

In an outpost repository, add `@achq/core` and the plugins `.achq/config.ts` imports:

```sh
bun add -D @achq/core @achq/github @achq/claude
```

| Package | Imported in | As |
| --- | --- | --- |
| [`@achq/core`](../packages/core.md) | Both | `import { achq, Container, Workspace, Trigger } from "@achq/core"` |
| [`@achq/cloudflare`](../packages/cloudflare.md) | `achq.infra.ts` | `import * as cloudflare from "@achq/cloudflare/infra"` |
| [`@achq/railway`](../packages/railway.md) | `achq.infra.ts` | `import * as railway from "@achq/railway/infra"` |
| [`@achq/github`](../packages/github.md) | Both | `"@achq/github/infra"` in `achq.infra.ts`, `"@achq/github"` in `.achq/config.ts` |
| [`@achq/claude`](../packages/claude.md) | `.achq/config.ts` | `import * as claude from "@achq/claude"` |

Keep their versions in step with `@achq/cli`. The CLI evaluates both files against its own copies of these packages, and the deployer evaluates `.achq/config.ts` in a sandbox that allows only `@achq/core`, `@achq/github`, `@achq/claude` and files inside `.achq/`.

## Provider CLIs

| CLI | Needed for | Login |
| --- | --- | --- |
| `gh` | GitHub repos | `gh auth login` |
| `claude` | `@achq/claude` token | `claude setup-token` |
| `npx wrangler@4` | Cloudflare HQs | `npx wrangler login` |
| `railway` | Railway HQs | `railway login` |
| `op` | 1Password vaults *(optional)* | `op signin` |
