import * as fs from "node:fs";
import * as path from "node:path";
import { disk } from "@achq/utils/disk";
import { subprocess } from "@achq/utils/subprocess";
import { ITEM_CATEGORY, NOT_AN_ITEM } from "./constants.ts";

/** An item as `op item get --format json` shows it: its fields by label, among others it has, e.g. a note's. */
export type OpItem = { id: string; title: string; fields?: { id: string; label?: string; value?: string }[] };

/** 1Password's CLI, `op`, as you're signed in to it: e.g. under `op run`, which the infra already runs with. */
export class Op {
  constructor(private readonly command: string[]) {}

  private async op(args: string[]) {
    return subprocess.collect([...this.command, ...args], { env: process.env });
  }

  /** Its stdout, or throws `failure` and what `op` said. */
  private async output(args: string[], failure: string) {
    return subprocess.output([...this.command, ...args], { env: process.env }, failure);
  }

  /** The item, or undefined if `vault` has none named `title`. */
  async get(vault: string, title: string): Promise<OpItem | undefined> {
    const result = await this.op(["item", "get", title, "--vault", vault, "--format", "json", "--reveal"]);
    if (!result.ok && NOT_AN_ITEM.test(result.stderr)) return undefined;
    if (!result.ok) throw new Error(`1Password couldn't read "${title}" from vault ${vault}: ${subprocess.said(result)}`);
    return JSON.parse(result.stdout) as OpItem;
  }

  /**
   * Makes an item of `fields`, each concealed. They go in a template file
   * readable by you alone, removed as soon as `op` has read it, so no value
   * is ever on a command line, where other processes can see it.
   */
  async create(vault: string, title: string, fields: Record<string, string>) {
    const template = {
      title,
      category: ITEM_CATEGORY,
      fields: Object.entries(fields).map(([label, value]) => ({ id: label, label, type: "CONCEALED", value })),
    };
    await disk.withTempDir("achq-op-", async (dir) => {
      const file = path.join(dir, "item.json");
      fs.writeFileSync(file, JSON.stringify(template), { mode: 0o600 });
      await this.output(["item", "create", "--vault", vault, "--template", file, "--format", "json"], `1Password couldn't make "${title}" in vault ${vault}`);
    });
  }

  /** Archives it, where it can still be restored from. */
  async archive(vault: string, id: string) {
    await this.output(["item", "delete", id, "--vault", vault, "--archive"], `1Password couldn't archive item ${id} in vault ${vault}`);
  }
}
