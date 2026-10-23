import { beforeEach, expect, test } from "bun:test";
import { type Change, plan, teardown } from "../src/engine/plan.ts";
import { all, type Input, type Inputs, known, type Planned, UNKNOWN } from "../src/engine/values.ts";
import { declared, resetDeclarations } from "../src/resources/resource.ts";
import { type Context, ManagedResource, Resource, type ResourceOptions } from "../src/resources/resource.ts";

type Db = { rows: Map<string, Row>; reads: string[]; writes: string[] };
type Row = { id: string; value: string };

let db: Db;
beforeEach(() => {
  db = { rows: new Map(), reads: [], writes: [] };
  resetDeclarations();
});

const ctx: Context = { env: {}, log: () => {}, newSecret: () => "secret", sleep: async () => {} };

/** A row whose value is its one prop. Its id is known once it exists. */
class Store extends ManagedResource<{ value: string }, Row, Row, "create" | "update"> {
  readonly kind = "store";
  constructor(name: string, value: Input<string>, options: ResourceOptions & { after?: ManagedResource[]; protect?: boolean } = {}) {
    super(name, { value }, options);
  }
  async read() {
    db.reads.push(this.name);
    const row = db.rows.get(this.name);
    return row && { ...row };
  }
  diff(props: { value: string }, current: Row | undefined) {
    return !current ? ["create" as const] : current.value !== props.value ? ["update" as const] : [];
  }
  describe(change: "create" | "update", props: { value: string }): Change {
    return change === "create" ? { op: "+", target: this.name, what: "row" } : { op: "~", target: this.name, what: "row", detail: known(props.value) ? props.value : "(known after apply)" };
  }
  planned(props: { value: string }, current: Row | undefined): Planned<Row> {
    return { id: current?.id ?? UNKNOWN, value: props.value };
  }
  async apply(props: { value: string }, current: Row | undefined) {
    db.writes.push(this.name);
    const row = { id: current?.id ?? `id-${this.name}`, value: props.value };
    db.rows.set(this.name, row);
    return { ...row };
  }
  check(_props: { value: string }, current: Row) {
    return [`${this.name} has ${current.value}`];
  }
}

/** A Store `achq infra down` can delete. */
class Doomed extends Store {
  async destroy() {
    db.writes.push(`-${this.name}`);
    db.rows.delete(this.name);
  }
}

/** A resource made of others: counts how often it's asked for them. */
class Group extends Resource {
  readonly kind = "group";
  asked = 0;
  parts: Resource[] = [];
  children() {
    this.asked++;
    return this.parts;
  }
}

const seed = (name: string, value: string) => db.rows.set(name, { id: `id-${name}`, value });
const summary = (changes: Change[]) => changes.map((c) => `${c.op} ${c.target} ${c.what}${c.detail ? ` ${c.detail}` : ""}`);

test("plan reads every resource and writes nothing; apply writes only what differs; then nothing changes", async () => {
  seed("same", "v");
  seed("stale", "old");
  const resources = () => [new Store("same", "v"), new Store("stale", "new"), new Store("fresh", "v")];

  const planned = await plan(resources(), ctx);
  expect(db.reads).toEqual(["same", "stale", "fresh"]);
  expect(db.writes).toEqual([]);
  expect(summary(planned.changes)).toEqual(["~ stale row new", "+ fresh row"]);

  await planned.apply();
  expect(db.writes).toEqual(["stale", "fresh"]);
  expect((await plan(resources(), ctx)).changes).toEqual([]);
});

test("resources are planned after what their props and `after` name, otherwise in the order given", async () => {
  const a = new Store("a", "v");
  const b = new Store("b", "v");
  const c = new Store("c", a.out("id"));
  const d = new Store("d", "v", { after: [b] });
  await (await plan([d, c, b, a], ctx)).apply();
  expect(db.writes).toEqual(["b", "d", "a", "c"]);
});

test("what a resource depends on is planned even if it wasn't given", async () => {
  const a = new Store("a", "v");
  await (await plan([new Store("b", a.out("id"))], ctx)).apply();
  expect(db.writes).toEqual(["a", "b"]);
});

test("what a resource depends on brings its children, asked for once however many depend on it", async () => {
  class Parent extends Store {
    asked = 0;
    readonly part = new Store("part", "v", { parent: this });
    children() {
      this.asked++;
      return [this.part];
    }
  }
  const a = new Parent("a", "v");
  const planned = await plan([new Store("b", a.out("id")), new Store("c", a.out("id"))], ctx);
  expect(a.asked).toBe(1);
  expect(summary(planned.changes)).toEqual(["+ a row", "+ b row", "+ part row", "+ c row"]);
});

test("a cycle throws, naming it with each resource's parent", async () => {
  const group = new Group("group");
  const x = new Store("x", "v", { parent: group });
  const y = new Store("y", "v", { parent: group, after: [x] });
  x.after.push(y);
  group.parts = [x, y];
  await expect(plan([group], ctx)).rejects.toThrow("A cycle: group/x → group/y → group/x");
});

test("a new resource's outputs are unknown when planned, and so is anything made from them", async () => {
  seed("old", "v");
  const old = new Store("old", "v");
  const fresh = new Store("fresh", "v");
  const planned = await plan([old, fresh], ctx);
  expect(planned.value(fresh.out("id"))).toBe(UNKNOWN);
  expect(planned.value(fresh.out("value"))).toBe("v");
  expect(planned.value(fresh.outputs())).toBe(UNKNOWN);
  expect(planned.value(fresh.out("id").map((id) => `${id}!`))).toBe(UNKNOWN);
  expect(planned.value(old.out("id").map((id) => `${id}!`))).toBe("id-old!");
  expect(planned.value(all([old.out("id"), "x"]))).toEqual(["id-old", "x"]);
});

test("`all` is unknown while any of its inputs is", async () => {
  const fresh = new Store("fresh", "v");
  const value = (await plan([fresh], ctx)).value(all([fresh.out("id"), "x"]));
  expect(known(value)).toBe(false);
});

test("once applied an output is known, and what took it is read and compared again with its value", async () => {
  seed("b", "stale");
  const a = new Store("a", "v");
  const b = new Store("b", a.out("id"));
  const planned = await plan([a, b], ctx);
  expect(summary(planned.changes)).toEqual(["+ a row", "~ b row (known after apply)"]);

  const applied = await planned.apply();
  expect(applied.value(a.out("id"))).toBe("id-a");
  expect(db.reads).toEqual(["a", "b", "b"]);
  expect(db.rows.get("b")!.value).toBe("id-a");
});

test("apply reads a resource again only if its props changed since planning", async () => {
  seed("a", "v");
  seed("b", "id-c");
  const a = new Store("a", "w");
  const c = new Store("c", "v");
  const b = new Store("b", c.out("id"), { after: [a] });
  const planned = await plan([a, b, c], ctx);
  db.reads.length = 0;
  await planned.apply();
  expect(db.reads).toEqual(["b"]);
});

test("a resource that matches once its inputs are known is read again but not written", async () => {
  seed("b", "id-a");
  const a = new Store("a", "v");
  const b = new Store("b", a.out("id"));
  await (await plan([a, b], ctx)).apply();
  expect(db.writes).toEqual(["a"]);
});

test("an input still unknown once what it comes from is applied throws, naming the resource and what it took from", async () => {
  /** Says its id is unknown even when there's nothing to apply. */
  class Vague extends Store {
    planned(props: { value: string }): Planned<Row> {
      return { id: UNKNOWN, value: props.value };
    }
  }
  seed("vague", "v");
  const group = new Group("group");
  const vague = new Vague("vague", "v");
  group.parts = [new Store("taker", vague.out("id"), { parent: group })];
  const planned = await plan([vague, group], ctx);
  await expect(planned.apply()).rejects.toThrow("group/taker: an input is still unknown after applying what it depends on (vague)");
});

test("children are asked for once per plan, even when reachable twice, and are planned", async () => {
  const shared = new Group("shared");
  shared.parts = [new Store("part", "v", { parent: shared })];
  const outer = new Group("outer");
  outer.parts = [shared];
  const planned = await plan([outer, shared], ctx);
  expect(shared.asked).toBe(1);
  expect(summary(planned.changes)).toEqual(["+ part row"]);
  await plan([outer], ctx);
  expect(shared.asked).toBe(2);
});

test("children and what achq makes aren't declared and skip the name rule; a top-level resource with a bad name throws", () => {
  const group = new Group("group");
  new Store("Not_A_Name", "v", { parent: group });
  expect(declared()).toEqual([group]);
  new Store("Made_By_Achq", "v", { declared: false });
  expect(declared()).toEqual([group]);
  expect(() => new Store("Not_A_Name", "v")).toThrow('Resource name "Not_A_Name" must be lowercase letters');
});

test("resources achq doesn't manage are ignored", async () => {
  const planned = await plan([new Group("plain")], ctx);
  expect(planned.changes).toEqual([]);
  expect(planned.warnings).toEqual([]);
});

test("checks warn only about resources that exist", async () => {
  seed("old", "v");
  const planned = await plan([new Store("old", "v"), new Store("fresh", "v")], ctx);
  expect(planned.warnings).toEqual(["old has v"]);
});

test("applied says which resources changed", async () => {
  seed("old", "v");
  const old = new Store("old", "v");
  const fresh = new Store("fresh", "v");
  const applied = await (await plan([old, fresh], ctx)).apply();
  expect(applied.changed(old)).toBe(false);
  expect(applied.changed(fresh)).toBe(true);
});

type Shape = { ids: string[]; value: string; plain: number };

test("a plan's and an apply's values resolve outputs nested in objects and arrays", async () => {
  seed("old", "v");
  const old = new Store("old", "v");
  const fresh = new Store("fresh", "w");
  // `value` takes an `Input<T>`, not `Inputs<T>`: an object holding outputs only type-checks cast.
  const input = { ids: [old.out("id"), fresh.out("id")], value: fresh.out("value"), plain: 1 } as Inputs<Shape> as Input<Shape>;
  const planned = await plan([old, fresh], ctx);
  expect<unknown>(planned.value(input)).toEqual({ ids: ["id-old", UNKNOWN], value: "w", plain: 1 });
  expect((await planned.apply()).value(input)).toEqual({ ids: ["id-old", "id-fresh"], value: "w", plain: 1 });
});

test("teardown deletes what exists, each before what it depends on, and lists what's protected instead of deleting it", async () => {
  seed("base", "v");
  seed("top", "v");
  seed("left", "v");
  const base = new Doomed("base", "v");
  const top = new Doomed("top", base.out("id"));
  const gone = new Doomed("gone", "v");
  // Goes with what it's part of.
  const part = new Store("part", "v", { after: [base] });
  seed("part", "v");
  const left = new Doomed("left", "v", { protect: true });

  const planned = await teardown([top, gone, part, left], ctx);
  expect(db.writes).toEqual([]);
  expect(summary(planned.changes)).toEqual(["- top store", "- base store"]);
  expect(planned.protected).toEqual([{ target: "left", what: "store" }]);

  await planned.apply();
  expect(db.writes).toEqual(["-top", "-base"]);
  expect([...db.rows.keys()].sort()).toEqual(["left", "part"]);
});
