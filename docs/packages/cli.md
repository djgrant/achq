# `@achq/cli`

`@achq/cli` provides the `achq` executable. It runs on [Bun](https://bun.sh):

```bash
@pm.add("-g @achq/cli")
```


| Command group | Purpose |
| --- | --- |
| `achq infra *` | Reconcile `achq.infra.ts` and inspect webhook deliveries |
| `achq repo *` | Subscribe repositories and inspect `ACHQ_STATUS` |
| `achq container *` | Attach to remote outpost containers (`resume`, `ssh`) |

See [CLI Reference](../manual/cli.md) for all commands and flags.

## `achq.config.ts`

Configure secret loading and vault storage for the CLI:

```ts [achq.config.ts]
import * as onepassword from "@achq/1password";

export default {
  env: "op run --env-file=.env --",
  vault: onepassword.vault("Operations"), // <-- any object that reads and writes items
};
```

Read from the ACHQ repository root before any `achq` command runs:

| Field | Behavior |
| --- | --- |
| `env` | Command prefix run once to populate `process.env` before pre-flight checks |
| `vault` | A vault (such as [`@achq/1password`](./1password.md)'s) to store generated channel keys: anything with `read(item)` and `write(item, fields)` |
