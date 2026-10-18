import { TERMINAL_ENV } from "../constants.ts";

export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** A container's shell may set only TERM=xterm; pass your terminal's on, so programs in it know its keys. */
export const terminalEnv = () => TERMINAL_ENV.flatMap((name) => (process.env[name] ? [`${name}=${process.env[name]}`] : []));
