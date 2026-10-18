import type { Expander, RouterHandle } from "@achq/core";
import { App } from "../../resources/app.ts";
import { type AppDeps, githubApp } from "./app.ts";

/** An App, with its webhook pointed at the router and its credential given to it. */
export const appExpander = (deps: AppDeps): Expander<App, void> => ({
  resource: App,
  expand(app, { graph: g, handle }) {
    const router = handle<RouterHandle>(app.inputs.router);
    const live = g.add(`github app ${app.inputs.name}`, githubApp(deps), async (o) => ({
      name: app.inputs.name,
      org: app.inputs.org,
      hookUrl: `${await o(router.publicUrl)}/webhook`,
      location: "store" as const,
      store: await o(router.secrets),
      key: await o(router.key),
    }));
    router.env.add(
      g.derive(`github app ${app.inputs.name} credential`, async (o) => {
        const { credential } = await o(live);
        return { values: { [credential.name]: credential.ref }, secrets: [credential] };
      }),
    );
  },
});

/** How `achq up` builds the infra's GitHub resources. */
export const githubExpanders = (deps: AppDeps): Expander[] => [appExpander(deps)];
