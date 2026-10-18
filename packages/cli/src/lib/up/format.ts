import type { SyncResult } from "@achq/core";

export const formatSync = (result: SyncResult, dryRun: boolean) => {
  const lines: string[] = [];
  const verb = (done: string, would: string) => (dryRun ? would : done);
  if (result.deployed.length) lines.push(`${verb("deployed", "would deploy")}: ${result.deployed.join(", ")}`);
  if (result.uninstalled.length) lines.push(`${verb("uninstalled", "would uninstall")}: ${result.uninstalled.join(", ")}`);
  if (result.pruned.length) lines.push(`${verb("pruned", "would prune")}: ${result.pruned.join(", ")}`);
  for (const f of result.failed) lines.push(`failed: ${f.repo}: ${f.error}`);
  if (result.unchanged.length) lines.push(`unchanged: ${result.unchanged.length} repo${result.unchanged.length === 1 ? "" : "s"}`);
  return lines.length ? lines : ["no repos installed"];
};
