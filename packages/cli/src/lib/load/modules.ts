import { INFRA_MODULES } from "achq/registry";

let registered = false;

export const registerModules = () => {
  if (registered) return;
  registered = true;
  Bun.plugin({
    name: "achq",
    setup(build) {
      for (const [specifier, exports] of Object.entries(INFRA_MODULES)) build.module(specifier, () => ({ exports: { ...exports }, loader: "object" }));
    },
  });
};
