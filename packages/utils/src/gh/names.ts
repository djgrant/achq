// `owner/name` repo names. GitHub compares them case-insensitively.

/** `owner/name`'s two parts. */
export const splitRepo = (fullName: string): { owner: string; name: string } => {
  const [owner = "", name = ""] = fullName.split("/");
  return { owner, name };
};

/** What a repo name is compared and keyed by. */
export const repoKey = (fullName: string) => fullName.toLowerCase();

export const sameRepo = (a: string, b: string) => repoKey(a) === repoKey(b);

/** Whether two logins (users or orgs) are the same account: GitHub ignores their case too. */
export const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
