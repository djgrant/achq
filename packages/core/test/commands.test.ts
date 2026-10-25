import { expect, test } from "bun:test";
import { COMMANDS, RUNNER_BINARY, resume, serve, sessions } from "../src/wire/commands.ts";

test("each command's argv starts with the runner's binary and the name it dispatches on", () => {
  expect(RUNNER_BINARY).toBe("achq-runner");
  expect(sessions()).toEqual([RUNNER_BINARY, COMMANDS.sessions]);
  expect(sessions("34")).toEqual([RUNNER_BINARY, COMMANDS.sessions, "34"]);
  expect(resume("34", "aaa111")).toEqual([RUNNER_BINARY, COMMANDS.resume, "34", "aaa111"]);
});

test("serve starts achq-runner", () => {
  expect(serve()).toEqual([RUNNER_BINARY]);
});
