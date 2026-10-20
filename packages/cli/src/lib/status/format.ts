import type { DeployRecord, InstalledRepo, Status } from "@achq/core";
import { alignedTable } from "@achq/utils/text";

const SHORT_SHA_LENGTH = 7;
const NONE = "-";
const INFRA_COLUMNS = ["REPO", "STATE", "AT", "CONTAINERS"];

const shortSha = (commit: string) => commit.slice(0, SHORT_SHA_LENGTH);

const containerNames = (containers: { name: string }[] | undefined) => (containers ?? []).map((c) => c.name);

/** e.g. `deployed at 2026-10-17T10:00:00Z (abc1234)`, or `failed at …: why`. */
const statusHeadline = (status: Status) => {
  const commit = status.commit ? ` (${shortSha(status.commit)})` : "";
  const error = status.error ? `: ${status.error}` : "";
  return `${status.state} at ${status.at}${commit}${error}`;
};

export const formatStatus = (status: Status) => {
  const lines = [statusHeadline(status)];
  const containers = containerNames(status.containers);
  if (containers.length) lines.push(`containers: ${containers.join(", ")}`);
  for (const w of status.warnings ?? []) lines.push(`! ${w}`);
  return lines;
};

/** A repo the router knows: installed on its code host, deployed, or both. */
type RepoRow = { repo: string; installed: boolean; record?: DeployRecord };

/** Repo names compare case-insensitively, as code hosts treat them. */
const repoKey = (repo: string) => repo.toLowerCase();

/** A record's spelling of the name wins. */
const joinByRepo = (records: DeployRecord[], installed: InstalledRepo[]): RepoRow[] => {
  const rows = new Map<string, RepoRow>();
  for (const i of installed) rows.set(repoKey(i.repo), { repo: i.repo, installed: true });
  for (const record of records) {
    const key = repoKey(record.repo);
    rows.set(key, { repo: record.repo, installed: rows.get(key)?.installed ?? false, record });
  }
  return [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
};

/** The deploy's state, flagging a repo that's only half set up. */
const repoState = ({ installed, record }: RepoRow) => {
  if (!record) return "installed, not deployed";
  if (!installed && record.state === "deployed") return "deployed, not installed";
  return record.state;
};

const infraRow = (row: RepoRow) => [row.repo, repoState(row), row.record?.at ?? NONE, containerNames(row.record?.containers).join(",") || NONE];

/** Every installed or deployed repo, one row each, with errors underneath. */
export const infraStatusTable = (records: DeployRecord[], installed: InstalledRepo[]) => {
  const rows = joinByRepo(records, installed);
  if (!rows.length) return "No repo is installed";
  const table = alignedTable([INFRA_COLUMNS, ...rows.map(infraRow)]);
  const errors = rows.flatMap(({ repo, record }) => (record?.error ? [`${repo}: ${record.error}`] : []));
  return [...table, ...(errors.length ? ["", ...errors] : [])].join("\n");
};
