// GitHub compares repo names case-insensitively.

export const splitRepo = (fullName: string): { owner: string; name: string } => {
  const [owner = "", name = ""] = fullName.split("/");
  return { owner, name };
};

export const repoKey = (fullName: string) => fullName.toLowerCase();

export const sameRepo = (a: string, b: string) => repoKey(a) === repoKey(b);

/** GitHub ignores their case too. */
export const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
