/**
 * What the deployer's own token needs on a repo: read `.achq/` and write the
 * ACHQ_STATUS variable. `actions_variables` is the token key for the
 * "Variables" repository permission. The OpenAPI `app-permissions` schema
 * doesn't list it, but GitHub's endpoint docs do:
 * https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
 */
export const DEPLOYER_PERMISSIONS = { contents: "read", metadata: "read", actions_variables: "write" } as const;

/** GitHub's rules for owner and repository names. */
export const REPO_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
