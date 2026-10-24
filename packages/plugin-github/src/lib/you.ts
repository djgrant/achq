import type { Vars } from "@achq/utils/env";
import { GitHub } from "@achq/utils/gh";
import { githubUrls } from "./constants.ts";

/** The API as you, through your gh login: the CLI's side. */
export const asYou = (env: Vars) => GitHub.connect({ token: GitHub.cliToken(env), baseUrl: githubUrls(env).api });
