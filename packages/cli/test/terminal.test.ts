import { expect, test } from "bun:test";
import * as path from "node:path";
import { createRawPrompter, type PromptCall } from "@pokit/core";
import { confirm, readSecret, waitForEnter } from "../io/terminal.ts";

test("a secret is read from stdin without a terminal, and isn't echoed", async () => {
  const terminal = path.join(import.meta.dir, "../io/terminal.ts");
  const proc = Bun.spawn([process.execPath, "-e", `const { createRawPrompter } = await import("@pokit/core"); const { readSecret } = await import(${JSON.stringify(terminal)}); process.stderr.write("got " + (await readSecret(createRawPrompter({}), "Token")));`], {
    cwd: path.join(import.meta.dir, ".."),
    stdin: new TextEncoder().encode("s3cret\n"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toBe("got s3cret");
  expect(stdout).toBe("  Token: \n");
});

test("without a terminal, a question isn't asked and the answer is no", async () => {
  const asked: PromptCall[] = [];
  const prompter = createRawPrompter({ confirmResponses: true, onPrompt: (call) => void asked.push(call) });
  expect(await confirm(prompter, "Delete all of this?")).toBe(false);
  expect(asked).toEqual([]);
});

test("waiting for Enter asks the prompter, and goes on once it's answered", async () => {
  const asked: PromptCall[] = [];
  const prompter = createRawPrompter({ selectResponses: true, onPrompt: (call) => void asked.push(call) });
  await waitForEnter(prompter, "Press Enter once you have.");
  expect(asked.map(({ type, options }) => [type, options.message])).toEqual([["select", "Press Enter once you have."]]);
});

test("at a terminal, a question is asked with no as the default, and the answer is the prompter's", async () => {
  const tty = [process.stdin.isTTY, process.stdout.isTTY];
  process.stdin.isTTY = process.stdout.isTTY = true;
  try {
    const asked: PromptCall[] = [];
    const prompter = createRawPrompter({ confirmResponses: [true, false], onPrompt: (call) => void asked.push(call) });
    expect([await confirm(prompter, "Delete all of this?"), await confirm(prompter, "Delete all of this?")]).toEqual([true, false]);
    expect(asked.map(({ options }) => options)).toEqual([{ message: "Delete all of this?", initialValue: false }, { message: "Delete all of this?", initialValue: false }]);
  } finally {
    [process.stdin.isTTY, process.stdout.isTTY] = tty as [true, true];
  }
});

test("at a terminal, a secret is asked for with the prompter's masked prompt", async () => {
  const tty = [process.stdin.isTTY, process.stdout.isTTY];
  process.stdin.isTTY = process.stdout.isTTY = true;
  try {
    const asked: PromptCall[] = [];
    const prompter = createRawPrompter({ passwordResponses: "s3cret", onPrompt: (call) => void asked.push(call) });
    expect(await readSecret(prompter, "Token")).toBe("s3cret");
    expect(asked.map(({ type, options }) => [type, options])).toEqual([["password", { message: "Token" }]]);
  } finally {
    [process.stdin.isTTY, process.stdout.isTTY] = tty as [true, true];
  }
});
