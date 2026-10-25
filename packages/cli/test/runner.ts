import { createEventBus, createRawPrompter, createRunner, type Prompter } from "@pokit/core";

/** A pok runner as a command gets one, with no terminal: tasks run through it with their params, and prompt `prompter`. */
export const testRunner = (prompter: Prompter = createRawPrompter({})) =>
  createRunner({ cwd: process.cwd(), context: {}, extraArgs: [], eventBus: createEventBus(), prompter });
