# `@achq/1password`

`@achq/1password` stores and retrieves ACHQ secrets (such as generated GitHub App credentials) in a 1Password vault via the `op` CLI. It ships with [`@achq/cli`](./cli.md), so there's nothing to install: name it in `achq.config.ts`.

Load CLI secrets and persist generated channel keys in a 1Password vault:

```ts [achq.config.ts]
export default {
  env: "op run --env-file=.env --",
  vault: {
    provider: "1password",
    name: "Operations", // <-- 1Password vault name passed to `op --vault`
  },
};
```

## Vault operations

Each channel secret is stored as a `SECURE_NOTE` item (for example, `"GitHub App acme-agents"` with fields `app_id` and `private_key`):

| Operation | `op` command |
| --- | --- |
| `read(item)` | `op item get <item> --vault <vault> --format json --reveal` |
| `write(item, fields)` | `op item create --vault <vault> --template <file>` (or `op item edit`) |
| `remove(item)` | `op item delete <item> --vault <vault> --archive` |

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACHQ_1PASSWORD_OP` | `"op"` | Overrides the `op` binary path |
