import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { flock } from "../src/flock.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const lockFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flock-"));
  dirs.push(dir);
  return path.join(dir, "nested", "a.lock");
};

describe("acquire", () => {
  test("a second holder waits until the first releases", async () => {
    const file = lockFile();
    const release = await flock.acquire(file);
    let second = false;
    const waiting = flock.acquire(file).then((r) => ((second = true), r));
    await Bun.sleep(300);
    expect(second).toBe(false);
    await release();
    await (await waiting)();
    expect(second).toBe(true);
  });

  test("withLock runs one at a time", async () => {
    const file = lockFile();
    const order: string[] = [];
    const task = (name: string) => flock.withLock(file, async () => {
      order.push(`${name} in`);
      await Bun.sleep(100);
      order.push(`${name} out`);
    });
    await Promise.all([task("a"), task("b")]);
    expect(order.join(",")).toMatch(/^(a in,a out,b in,b out|b in,b out,a in,a out)$/);
  });
});

describe("lockedArgv", () => {
  test("exits flock.BUSY without running the command while the lock is held, and runs it once it's free", async () => {
    const file = lockFile();
    const marker = `${file}.ran`;
    const release = await flock.acquire(file);
    const busy = Bun.spawn(flock.lockedArgv(file, ["touch", marker]));
    expect(await busy.exited).toBe(flock.BUSY);
    expect(fs.existsSync(marker)).toBe(false);
    await release();
    expect(await Bun.spawn(flock.lockedArgv(file, ["touch", marker])).exited).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
  });

  test("the command holds the lock while it runs, and killing it frees the lock", async () => {
    const file = lockFile();
    const holder = Bun.spawn(flock.lockedArgv(file, ["sleep", "30"]));
    await Bun.sleep(300);
    expect(await Bun.spawn(flock.lockedArgv(file, ["true"])).exited).toBe(flock.BUSY);
    holder.kill("SIGKILL");
    await holder.exited;
    expect(await Bun.spawn(flock.lockedArgv(file, ["true"])).exited).toBe(0);
  });
});
