import { defineTask } from "@pokit/core";
import type { RouterAdmin } from "@achq/core/clients/router";
import type { DeployerVersion } from "@achq/core/protocol";
import { async } from "@achq/utils/async";
import { json } from "@achq/utils/json";
import { time } from "@achq/utils/time";
import * as v from "valibot";
import { given, log, sleep } from "./params.ts";

/** How long a new deployer is waited for to replace the one running, and how often it's asked what it runs. */
const DEPLOYER_VERSION_TIMEOUT_MS = 10 * time.MINUTE_MS;
const DEPLOYER_VERSION_INTERVAL_MS = 5000;

/** `@achq/deployer@<version>`, and its plugins', for messages. */
const describe = ({ version, plugins }: DeployerVersion) => [`@achq/deployer@${version}`, ...plugins.map((p) => `${p.package}@${p.version}`)].join(", ");

/** Waits until the deployer runs `wanted`: its version, with the plugins it was given. */
export const infraAwaitDeployer = defineTask({
  label: "Wait for the deployer",
  params: v.object({ admin: given<RouterAdmin>(), wanted: given<DeployerVersion>(), log, sleep }),
  run: async (_r, { params: { admin, wanted, log, sleep } }) => {
    const same = (running: DeployerVersion | undefined) => !!running && running.version === wanted.version && json.stableStringify(running.plugins) === json.stableStringify(wanted.plugins);
    // A deployer, or router, that's still starting doesn't answer, which counts as not yet.
    const running = () => admin.deployerVersion().catch(() => undefined);
    if (same(await running())) return;
    log(`  waiting for the deployer to run ${describe(wanted)}…`);
    await async.pollOrThrow(running, same, {
      intervalMs: DEPLOYER_VERSION_INTERVAL_MS,
      timeoutMs: DEPLOYER_VERSION_TIMEOUT_MS,
      sleep,
      timedOut: (after) => `The deployer isn't running ${describe(wanted)} after ${after}; see its logs on its container provider`,
    });
  },
});
