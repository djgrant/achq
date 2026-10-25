# Installation

## CLI

Install the `achq` CLI on your machine:

```sh
git clone https://github.com/djgrant/achq.git
cd achq && bun install
ln -sf "$PWD/packages/cli/bin/achq" ~/.local/bin/achq
```

## Repo types

Add type-checking to an infrastructure or outpost repository:

```sh
bun add -D github:djgrant/achq#main
```

Adds type definitions for `achq.infra.ts` and `.achq/config.ts`.

## Provider CLIs

| CLI | Needed for | Login |
| --- | --- | --- |
| `gh` | GitHub repos | `gh auth login` |
| `claude` | `@achq/claude` token | `claude setup-token` |
| `npx wrangler@4` | Cloudflare HQs | `npx wrangler login` |
| `railway` | Railway HQs | `railway login` |
| `op` | 1Password vaults *(optional)* | `op signin` |
