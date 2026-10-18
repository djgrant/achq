import { TERMINAL_ENV } from "../constants.ts";

export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Railway's SSH sets TERM=xterm and nothing else; pass your terminal's on so Claude knows its keys. */
export const terminalEnv = () => TERMINAL_ENV.flatMap((name) => (process.env[name] ? [`${name}=${process.env[name]}`] : []));
