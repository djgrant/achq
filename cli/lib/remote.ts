// `achq ssh` and `resume`: find a repo's container from its ACHQ_STATUS, wake
// it through the router, and `railway ssh` in.
import type { Status } from "../../src/core/protocol.ts";

export type Located = { name: string; platform: string; project: string; environment: string; service: string };

/** The containers ACHQ_STATUS says the repo has, with where to find them. */
export const containersOf = (status: Status): Located[] =>
  (status.containers ?? []).flatMap((c) => {
    const { platform, project, environment, service } = c.location;
    return platform === "railway" && project && environment && service ? [{ name: c.name, platform, project, environment, service }] : [];
  });

/** The one container, the one `wanted` names, or `undefined` when the caller has to ask. */
export const pickContainer = (containers: Located[], wanted?: string) => {
  if (wanted) {
    const found = containers.find((c) => c.name === wanted);
    if (!found) throw new Error(`No container ${wanted}; there's ${containers.map((c) => c.name).join(", ") || "none"}`);
    return found;
  }
  if (!containers.length) throw new Error("ACHQ_STATUS lists no containers. Has the repo deployed? (achq status)");
  return containers.length === 1 ? containers[0] : undefined;
};

/** Asks the router to wake the container. It checks you can push to the repo. */
export const wake = async (router: string, repo: string, container: string, token: string) => {
  const res = await fetch(`${router}/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ repo, container }),
  });
  if (!res.ok) throw new Error(`Couldn't wake ${container}: ${res.status} ${await res.text()}`);
};

export const sshArgs = (c: Located, command: string[]) => [
  "ssh",
  "--project",
  c.project,
  "--environment",
  c.environment,
  "--service",
  c.service,
  ...(command.length ? ["--", ...command] : []),
];

const needRailway = () => {
  if (!Bun.which("railway")) throw new Error("Needs the Railway CLI: brew install railway");
};

/** `railway ssh` into the container, interactively or running `command`. Its exit code. */
export const railwaySsh = async (c: Located, command: string[]) => {
  needRailway();
  const proc = Bun.spawn(["railway", ...sshArgs(c, command)], { stdio: ["inherit", "inherit", "inherit"] });
  return proc.exited;
};

/** Runs `command` in the container and returns its stdout. */
export const railwayRun = async (c: Located, command: string[]) => {
  needRailway();
  const proc = Bun.spawn(["railway", ...sshArgs(c, command)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed in ${c.service}: ${err.trim() || out.trim()}`);
  return out;
};

/** Railway's SSH sets TERM=xterm and nothing else; pass your terminal's on so Claude knows its keys. */
export const terminalEnv = () =>
  ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"].flatMap((name) => (process.env[name] ? [`${name}=${process.env[name]}`] : []));

// ── Sessions ─────────────────────────────────────────────────────────────────

export type SessionRow = { id: string; agent: string; workspace?: string; lastRun?: string };

/**
 * `achq-agent sessions <n>`'s output: a JSON array of sessions. Anything
 * before the JSON (an SSH banner) is skipped.
 */
export const parseSessions = (out: string): SessionRow[] => {
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`Unexpected output from achq-agent sessions: ${out.trim().slice(0, 200)}`);
  const rows = JSON.parse(out.slice(start)) as SessionRow[];
  if (!Array.isArray(rows)) throw new Error("achq-agent sessions didn't return a list");
  return rows.sort((a, b) => (b.lastRun ?? "").localeCompare(a.lastRun ?? ""));
};

/** The session to open: the one asked for, the only one, or `undefined` to ask. */
export const pickSession = (sessions: SessionRow[], wanted?: string) => {
  if (wanted) {
    const found = sessions.find((s) => s.id === wanted || s.id.startsWith(wanted) || s.agent === wanted);
    if (!found) throw new Error(`No session ${wanted}`);
    return found;
  }
  if (!sessions.length) throw new Error("The thread has no sessions");
  return sessions.length === 1 ? sessions[0] : undefined;
};

export const sessionLabel = (s: SessionRow) => `${s.agent}${s.workspace ? ` (${s.workspace})` : ""}`;

/** The minimal list, for when there's no terminal to pick in. */
export const sessionTable = (sessions: SessionRow[]) => {
  const rows = [["ID", "AGENT", "LAST RUN"], ...sessions.map((s) => [s.id, sessionLabel(s), s.lastRun ?? "-"])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
};
