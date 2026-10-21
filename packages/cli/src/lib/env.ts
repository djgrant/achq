import { Env } from "@achq/utils/env";

export const need = (name: string, hint = "") => new Env(process.env).require(name, hint);
