# `@achq/1password`

`@achq/1password` stores and retrieves ACHQ secrets (such as generated GitHub App credentials) in a 1Password vault via the `op` CLI. Add it to the infrastructure repository and give its vault in `achq.config.ts`.

```bash
@pm.dev("@achq/1password")
```

Load CLI secrets and persist generated channel keys in a 1Password vault:

```ts [achq.config.ts]
import * as onepassword from "@achq/1password";

export default {
  env: "op run --env-file=.env --",
  vault: onepassword.vault("Operations"), // <-- 1Password vault name passed to `op --vault`
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
