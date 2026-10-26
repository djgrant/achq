# `@achq/cli`

`@achq/cli` provides the `achq` executable. It runs on [Bun](https://bun.sh):

```sh
bun add -g @achq/cli
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
export default {
  env: "op run --env-file=.env --",
  vault: {
    provider: "1password", // <-- registered VaultProvider id
    name: "Operations",    // <-- vault name passed to the provider
  },
};
```

Read from the ACHQ repository root before any `achq` command runs:

| Field | Behavior |
| --- | --- |
| `env` | Command prefix run once to populate `process.env` before pre-flight checks |
| `vault` | Selects a `VaultProvider` (such as [`@achq/1password`](./1password.md)) to store generated channel keys |
