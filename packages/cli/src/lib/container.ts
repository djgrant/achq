import type { Prompter } from "@pokit/core";
import type { ContainerShell, Status, WakeRequest } from "@achq/core";
import { SessionSummary } from "@achq/core/protocol";
import { http } from "@achq/utils/http";
import { text } from "@achq/utils/text";
import { findContainerProvider } from "achq/registry";
import { z } from "zod";
import { chooseOne } from "./terminal.ts";
import { notSetUp, type RepoHere } from "./workdir.ts";

/** How much of unexpected output goes into the error: enough to see what answered. */
const UNEXPECTED_OUTPUT_CHARS = 200;
const SESSION_COLUMNS = ["ID", "THREAD", "AGENT", "LAST RUN"];

export type Located = { name: string; location: Record<string, string>; shell: ContainerShell };

/** The containers ACHQ_STATUS says the repo has, that a container provider achq knows can reach. */
export const containersOf = (status: Status): Located[] =>
  (status.containers ?? []).flatMap((c) => {
    const shell = findContainerProvider(c.location.containerProvider)?.shell;
    return shell?.reachable(c.location) ? [{ name: c.name, location: c.location, shell }] : [];
  });

/** The one container, the one `wanted` names, or `undefined` when the caller has to ask. */
export const pickContainer = (containers: Located[], wanted?: string, repo = "The repo") => {
  if (wanted) {
    const found = containers.find((c) => c.name === wanted);
    if (!found) throw new Error(`No container ${wanted}; there's ${containers.map((c) => c.name).join(", ") || "none"}`);
    return found;
  }
  if (!containers.length) throw new Error(`${repo} has no containers yet. \`achq repo status\` shows how its last deploy went.`);
  return containers.length === 1 ? containers[0] : undefined;
};

/** The repo's container, picked and woken through the router. */
export const reachContainer = async (prompter: Prompter, { host, repo, codeHost }: RepoHere, wanted?: string) => {
  // ACHQ_STATUS says where the repo's containers are, and which router fronts them.
  const status = await codeHost.status(repo);
  if (!status) throw new Error(notSetUp(repo));
  const containers = containersOf(status);
  const container = await chooseOne(prompter, containers, pickContainer(containers, wanted, repo), {
    message: "Container",
    id: (c) => c.name,
    label: (c) => c.name,
    withoutTerminal: () => {
      throw new Error(`${repo} has several containers; pick one with --container (${containers.map((c) => c.name).join(", ")})`);
    },
  });
  // The router checks, on the repo's host, that you can push to the repo.
  const res = await fetch(`${status.router}/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${codeHost.token()}`, "content-type": "application/json" },
    body: JSON.stringify({ host, repo, container: container.name } satisfies WakeRequest),
  });
  await http.expectOk(res, `Couldn't wake ${container.name}`);
  return container;
};

/**
 * `achq-agent sessions [n]`'s output: a JSON array of sessions, most recently
 * run first. Anything before the JSON (an SSH banner) is skipped.
 */
export const parseSessions = (out: string) => {
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`Unexpected output from achq-agent sessions: ${out.trim().slice(0, UNEXPECTED_OUTPUT_CHARS)}`);
  const sessions = z.array(SessionSummary).safeParse(JSON.parse(out.slice(start)));
  if (!sessions.success) throw new Error(`achq-agent sessions didn't return a list of sessions: ${z.prettifyError(sessions.error)}`);
  return sessions.data;
};

/** The session to open: the one asked for, the only one, or `undefined` to ask. */
export const pickSession = (sessions: SessionSummary[], wanted?: string, thread?: string) => {
  if (wanted) {
    const found = sessions.find((s) => s.id === wanted || s.id.startsWith(wanted) || s.agent === wanted);
    if (!found) throw new Error(`No session ${wanted}`);
    return found;
  }
  if (!sessions.length) throw new Error(thread ? `Thread ${thread} has no sessions` : "There are no sessions yet: mention an agent on an issue to start one");
  return sessions.length === 1 ? sessions[0] : undefined;
};

export const sessionLabel = (s: SessionSummary) => `#${s.thread} ${s.agent} (${s.workspace})`;

/** The minimal list, for when there's no terminal to pick in. */
export const sessionTable = (sessions: SessionSummary[]) =>
  text.alignedTable([SESSION_COLUMNS, ...sessions.map((s) => [s.id, `#${s.thread}`, `${s.agent} (${s.workspace})`, s.lastRun])]).join("\n");
