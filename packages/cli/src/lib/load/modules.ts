// `achq`, `achq/github` and `achq/railway` imports resolve to this checkout's
// modules. That way the resources a config declares are the same classes the
// CLI's `instanceof` checks use.
import * as achq from "achq";
import * as github from "achq/github";
import * as railway from "achq/railway";

let registered = false;

export const registerModules = () => {
  if (registered) return;
  registered = true;
  const modules: Record<string, object> = { achq, "achq/github": github, "achq/railway": railway };
  Bun.plugin({
    name: "achq",
    setup(build) {
      for (const [specifier, exports] of Object.entries(modules)) build.module(specifier, () => ({ exports: { ...exports }, loader: "object" }));
    },
  });
};
