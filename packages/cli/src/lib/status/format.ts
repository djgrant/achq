import type { DeployRecord, Installation, Status } from "@achq/core";

export const formatStatus = (status: Status) => {
  const lines = [`${status.state} at ${status.at}${status.commit ? ` (${status.commit.slice(0, 7)})` : ""}${status.error ? `: ${status.error}` : ""}`];
  if (status.containers?.length) lines.push(`containers: ${status.containers.map((c) => c.name).join(", ")}`);
  for (const w of status.warnings ?? []) lines.push(`! ${w}`);
  return lines;
};

/** Every installed or deployed repo, one row each, with errors underneath. */
export const infraStatusTable = (records: DeployRecord[], installations: Installation[]) => {
  const repos = new Map<string, { app: string; installed: boolean; record?: DeployRecord }>();
  for (const i of installations) repos.set(i.repo.toLowerCase(), { app: i.source, installed: true });
  for (const r of records) {
    const row = repos.get(r.repo.toLowerCase());
    repos.set(r.repo.toLowerCase(), { app: r.source, installed: row?.installed ?? false, record: r });
  }
  if (!repos.size) return "No repos have installed an App";
  const names = new Map([...installations.map((i) => [i.repo.toLowerCase(), i.repo] as const), ...records.map((r) => [r.repo.toLowerCase(), r.repo] as const)]);
  const rows = [["REPO", "APP", "STATE", "AT", "CONTAINERS"]];
  const errors: string[] = [];
  for (const [key, { app, installed, record }] of [...repos].sort(([a], [b]) => a.localeCompare(b))) {
    const repo = names.get(key)!;
    const state = record ? (installed || record.state !== "deployed" ? record.state : "deployed, not installed") : "installed, not deployed";
    rows.push([repo, app, state, record?.at ?? "-", record?.containers?.map((c) => c.name).join(",") || "-"]);
    if (record?.error) errors.push(`${repo}: ${record.error}`);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const table = rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
  return [...table, ...(errors.length ? ["", ...errors] : [])].join("\n");
};
