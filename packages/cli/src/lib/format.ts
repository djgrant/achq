import { type DeployRecord, type FailedDelivery, type InstalledRepo, type Plan, type ReplayResult, repoName, type Status, type SyncResult, threadKey } from "@achq/core";
import { text } from "@achq/utils/text";

const SHORT_SHA_LENGTH = 7;
const NONE = "-";
const INFRA_COLUMNS = ["REPO", "STATE", "AT", "CONTAINERS"];

const containerNames = (containers: { name: string }[] | undefined) => (containers ?? []).map((c) => c.name);

/** `1 delivery`, `2 deliveries`. */
const deliveries = (n: number) => `${n} ${text.plural(n, "delivery", "deliveries")}`;

/** Each change on a line, its details lined up in a column. */
export const planLines = ({ changes, warnings }: Pick<Plan, "changes" | "warnings">) => [
  ...text.alignedTable(changes.map((c) => [`${c.op} ${c.target}`, c.detail ?? ""])),
  ...warnings.map((w) => `! ${w}`),
];

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

/** Headed e.g. `deployed at 2026-10-17T10:00:00Z (abc1234)`, or `failed at …: why`. */
export const formatStatus = (status: Status) => {
  const commit = status.commit ? ` (${status.commit.slice(0, SHORT_SHA_LENGTH)})` : "";
  const error = status.error ? `: ${status.error}` : "";
  const lines = [`${status.state} at ${status.at}${commit}${error}`];
  const containers = containerNames(status.containers);
  if (containers.length) lines.push(`containers: ${containers.join(", ")}`);
  for (const w of status.warnings ?? []) lines.push(`! ${w}`);
  return lines;
};

/** Every installed or deployed repo, one row each, with errors underneath. */
export const infraStatusTable = (records: DeployRecord[], installed: InstalledRepo[]) => {
  // A repo the router knows: installed on its code host, deployed, or both. A record's spelling of the name wins.
  const repos = new Map<string, { repo: string; installed: boolean; record?: DeployRecord }>();
  for (const i of installed) repos.set(repoName.key(i.repo), { repo: i.repo, installed: true });
  for (const record of records) {
    const key = repoName.key(record.repo);
    repos.set(key, { repo: record.repo, installed: repos.get(key)?.installed ?? false, record });
  }
  const rows = [...repos].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
  if (!rows.length) return "No repo is installed";

  const table = text.alignedTable([
    INFRA_COLUMNS,
    ...rows.map(({ repo, installed, record }) => {
      // The deploy's state, flagging a repo that's only half set up.
      const state = !record ? "installed, not deployed" : !installed && record.state === "deployed" ? "deployed, not installed" : record.state;
      return [repo, state, record?.at ?? NONE, containerNames(record?.containers).join(",") || NONE];
    }),
  ]);
  const errors = rows.flatMap(({ repo, record }) => (record?.error ? [`${repo}: ${record.error}`] : []));
  return [...table, ...(errors.length ? ["", ...errors] : [])].join("\n");
};

/** Under the status table: each failed delivery's targets and why, or nothing when there are none. */
export const failedSection = (failed: FailedDelivery[]) => {
  if (!failed.length) return [];
  const lines = failed.flatMap((f) => {
    const about = f.thread ? threadKey(f.thread) : (f.repo ?? "-");
    return f.targets.map((t) => `  ${f.delivery}  ${f.type}  ${about} → ${t.target}: ${t.error}`);
  });
  return ["", `${deliveries(failed.length)} failed. Run \`achq infra replay\` to send ${failed.length === 1 ? "it" : "them"} again:`, ...lines];
};

export const formatReplay = ({ replayed, dropped }: ReplayResult) => {
  if (!replayed.length && !dropped.length) return ["No delivery has failed"];
  return [
    ...(replayed.length ? [`Replaying ${deliveries(replayed.length)}: ${replayed.join(", ")}. \`achq infra status\` shows any that fail again.`] : []),
    ...(dropped.length ? [`Dropped ${deliveries(dropped.length)} whose repo or container is gone: ${dropped.join(", ")}`] : []),
  ];
};
