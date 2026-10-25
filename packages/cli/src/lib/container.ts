import type { Prompter } from "@pokit/core";
import type { ContainerShell, Status } from "@achq/core";
import { routerForPusher } from "@achq/core/clients/router";
import { OLD_RUNNER_BINARY, parseSessions, RUNNER_BINARY, type RunnerBinary, sessions as sessionsArgv } from "@achq/core/commands";
import type { SessionSummary } from "@achq/core/protocol";
import { errors } from "@achq/utils/errors";
import { text } from "@achq/utils/text";
import { findContainerProvider } from "achq/registry";
import { chooseOne } from "./terminal.ts";
import { notSetUp, type RepoHere } from "./workdir.ts";

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

/** What a shell or SSH says when it can't find `binary`: sh's and bash's "not found", exec's "No such file", or the shell's exit status for it, 127. */
const notFound = (said: string, binary: string) =>
  new RegExp(`${binary}\\W{0,3}(command )?not found|${binary}\\W{0,3}no such file|"${binary}": executable file not found|exit(ed)?( with)? (status|code):? 127\\b`, "i").test(said);

/**
 * A thread's sessions, or every thread's, from the container's runner, and the
 * name of its binary that answered, which `resume` then runs.
 */
export const listSessions = async (container: Pick<Located, "location" | "shell">, thread?: string): Promise<{ sessions: SessionSummary[]; binary: RunnerBinary }> => {
  const list = async (binary: RunnerBinary) => ({ sessions: parseSessions(await container.shell.run(container.location, sessionsArgv(thread, binary)), binary), binary });
  try {
    return await list(RUNNER_BINARY);
  } catch (error) {
    // compat: delete once deployed repos' images are all built by an install.sh that links achq-runner. One an older install.sh built has only achq-agent.
    if (notFound(errors.message(error), RUNNER_BINARY)) return list(OLD_RUNNER_BINARY);
    throw error;
  }
};

/** The repo's container, picked and woken through the router. */
export const reachContainer = async (prompter: Prompter, { repo, codeHost }: RepoHere, wanted?: string) => {
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
  // The router checks, on the code host, that you can push to the repo.
  await routerForPusher({ url: status.router, token: codeHost.token() }).wake({ body: { repo, container: container.name } });
  return container;
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
