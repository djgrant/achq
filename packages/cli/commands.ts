import { type CommandConfig, fromStatic } from "@pokit/core";
import { command as container } from "./commands/container.ts";
import { command as containerResume } from "./commands/container.resume.ts";
import { command as containerSsh } from "./commands/container.ssh.ts";
import { command as infra } from "./commands/infra.ts";
import { command as infraDown } from "./commands/infra.down.ts";
import { command as infraReplay } from "./commands/infra.replay.ts";
import { command as infraStatus } from "./commands/infra.status.ts";
import { command as infraUp } from "./commands/infra.up.ts";
import { command as repo } from "./commands/repo.ts";
import { command as repoInstall } from "./commands/repo.install.ts";
import { command as repoStatus } from "./commands/repo.status.ts";
import { command as repoUninstall } from "./commands/repo.uninstall.ts";

/**
 * achq's commands by name, as pok finds them in commands/: listed, so a bundle
 * has them without reading the directory. A test checks the list against it.
 */
export const COMMANDS: Record<string, CommandConfig> = {
  container: container as CommandConfig,
  "container.resume": containerResume as CommandConfig,
  "container.ssh": containerSsh as CommandConfig,
  infra: infra as CommandConfig,
  "infra.down": infraDown as CommandConfig,
  "infra.replay": infraReplay as CommandConfig,
  "infra.status": infraStatus as CommandConfig,
  "infra.up": infraUp as CommandConfig,
  repo: repo as CommandConfig,
  "repo.install": repoInstall as CommandConfig,
  "repo.status": repoStatus as CommandConfig,
  "repo.uninstall": repoUninstall as CommandConfig,
};

export const commands = fromStatic(COMMANDS);
