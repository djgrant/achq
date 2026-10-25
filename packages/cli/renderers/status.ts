import { type DeployRecord, type InstalledRepo, repoName, type Status } from "@achq/core";
import { text } from "@achq/utils/text";

const SHORT_SHA_LENGTH = 7;
const NONE = "-";
const INFRA_COLUMNS = ["REPO", "STATE", "AT", "CONTAINERS"];

/** A commit's sha, cut to its usual short form. */
export const shortSha = (sha: string) => sha.slice(0, SHORT_SHA_LENGTH);

const containerNames = (containers: { name: string }[] | undefined) => (containers ?? []).map((c) => c.name);

/** Headed e.g. `deployed at 2026-10-17T10:00:00Z (abc1234)`, or `failed at …: why`. */
export const formatStatus = (status: Status) => {
  const commit = status.commit ? ` (${shortSha(status.commit)})` : "";
  const error = status.error ? `: ${status.error}` : "";
  const lines = [`${status.state} at ${status.at}${commit}${error}`];
  const containers = containerNames(status.containers);
  if (containers.length) lines.push(`containers: ${containers.join(", ")}`);
  for (const w of status.warnings ?? []) lines.push(`! ${w}`);
  if (status.action) lines.push(`to fix: ${status.action.what}, at ${status.action.url}`);
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
