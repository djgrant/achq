import { CodeHost as CoreCodeHost } from "@achq/core";
import { PLUGIN } from "../plugin.ts";
import { githubCodeHostProvider } from "./index.ts";

/** GitHub as the infra's code host: `new github.CodeHost("github")`. Its repos are reached through the infra's Apps, and from your machine through your `gh` login. */
export class CodeHost extends CoreCodeHost {
  readonly plugin = PLUGIN;
  readonly implementation = githubCodeHostProvider;
}
