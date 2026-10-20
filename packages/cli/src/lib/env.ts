import { requireEnv } from "@achq/utils/env";

export const need = (name: string, hint = "") => requireEnv(process.env, name, hint);
