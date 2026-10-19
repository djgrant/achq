/** What any repo's config needs from its App: pushes keep the deployment in line with the config, and the deployer writes ACHQ_STATUS. */
export const CONFIG_EVENTS = ["push"];
export const CONFIG_PERMISSIONS: Record<string, string> = { metadata: "read", actions_variables: "write" };
