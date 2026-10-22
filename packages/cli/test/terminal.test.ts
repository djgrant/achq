import { expect, test } from "bun:test";
import * as path from "node:path";

test("a secret is read from stdin without a terminal, and isn't echoed", async () => {
  const terminal = path.join(import.meta.dir, "../src/lib/terminal.ts");
  const proc = Bun.spawn([process.execPath, "-e", `const { readSecret } = await import(${JSON.stringify(terminal)}); process.stderr.write("got " + (await readSecret("Token")));`], {
    stdin: new TextEncoder().encode("s3cret\n"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toBe("got s3cret");
  expect(stdout).toBe("  Token: \n");
});
