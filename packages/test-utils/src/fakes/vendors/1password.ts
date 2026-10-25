import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeBin } from "../../helpers/fake-bin.ts";

export type FakeOpItem = { id: string; vault: string; title: string; archived: boolean; fields: { id: string; label: string; type: string; value: string }[] };

/**
 * An `op` that keeps items in a file, for `item get --format json`, `item
 * create --template` and `item delete --archive` as achq calls them, and
 * records each call's arguments. It never reaches 1Password. `bin` is the
 * command, for ACHQ_1PASSWORD_OP.
 */
export const fakeOp = ({ fails = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "achq-fake-op-"));
  const state = path.join(dir, "items.json");
  const calls = path.join(dir, "calls.json");
  fs.writeFileSync(state, "[]");
  fs.writeFileSync(calls, "[]");
  const bin = fakeBin(
    dir,
    "op",
    `const fs = require("node:fs");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const items = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify([...JSON.parse(fs.readFileSync(${JSON.stringify(calls)}, "utf8")), args]));
if (${fails}) { console.error("[ERROR] 2026/10/22 12:00:00 You are not currently signed in."); process.exit(1); }
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(items));
const vault = flag("--vault");
const shown = (item) => ({ id: item.id, title: item.title, vault: { name: item.vault }, category: "SECURE_NOTE", fields: [{ id: "notesPlain", label: "notesPlain", type: "STRING", purpose: "NOTES" }, ...item.fields] });
const [noun, verb, name] = args;
if (noun === "item" && verb === "get") {
  const found = items.filter((i) => !i.archived && i.vault === vault && (i.title === name || i.id === name));
  if (!found.length) { console.error('[ERROR] 2026/10/22 12:00:00 "' + name + '" isn\\'t an item in the "' + vault + '" vault. Specify the item with its UUID, name, or domain.'); process.exit(1); }
  if (found.length > 1) { console.error("[ERROR] More than one item matches"); process.exit(1); }
  console.log(JSON.stringify(shown(found[0])));
} else if (noun === "item" && verb === "create") {
  const template = JSON.parse(fs.readFileSync(flag("--template"), "utf8"));
  const item = { id: "item" + (items.length + 1), vault, title: template.title, archived: false, fields: template.fields };
  items.push(item);
  save();
  console.log(JSON.stringify(shown(item)));
} else if (noun === "item" && verb === "delete" && args.includes("--archive")) {
  const item = items.find((i) => i.id === name && i.vault === vault);
  if (!item) { console.error("[ERROR] isn't an item"); process.exit(1); }
  item.archived = true;
  save();
} else { console.error("fake op doesn't know " + args.join(" ")); process.exit(2); }
`,
  );
  return {
    bin,
    items: () => JSON.parse(fs.readFileSync(state, "utf8")) as FakeOpItem[],
    /** Each call's arguments, in order. */
    calls: () => JSON.parse(fs.readFileSync(calls, "utf8")) as string[][],
    /** An item as if someone made it in 1Password. */
    add: (vault: string, title: string, fields: Record<string, string>) => {
      const items = JSON.parse(fs.readFileSync(state, "utf8")) as FakeOpItem[];
      items.push({ id: `item${items.length + 1}`, vault, title, archived: false, fields: Object.entries(fields).map(([label, value]) => ({ id: label, label, type: "CONCEALED", value })) });
      fs.writeFileSync(state, JSON.stringify(items));
    },
    stop: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

export type FakeOp = ReturnType<typeof fakeOp>;
