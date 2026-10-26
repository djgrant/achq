import type { SyncResult } from "@achq/core/protocol";
import { text } from "@achq/utils/text";

/** What a sync did, or would do on a dry run, a line for each kind of change. */
export const formatSync = (result: SyncResult, dryRun: boolean) => {
  const lines: string[] = [];
  const verb = (done: string, would: string) => (dryRun ? would : done);
  if (result.deployed.length) lines.push(`${verb("deployed", "would deploy")}: ${result.deployed.join(", ")}`);
  if (result.uninstalled.length) lines.push(`${verb("uninstalled", "would uninstall")}: ${result.uninstalled.join(", ")}`);
  if (result.pruned.length) lines.push(`${verb("pruned", "would prune")}: ${result.pruned.join(", ")}`);
  for (const f of result.failed) lines.push(`failed: ${f.repo}: ${f.error}`);
  if (result.unchanged.length) lines.push(`unchanged: ${result.unchanged.length} ${text.plural(result.unchanged.length, "repo")}`);
  return lines.length ? lines : ["no repos installed"];
};
