/** The repo a GitHub remote URL (https or ssh) names. */
export const repoOf = (remote: string, web: string) => {
  const host = new URL(web).host.replace(/[.]/g, "\\.");
  return remote.trim().match(new RegExp(`${host}[:/]([\\w.-]+/[\\w.-]+?)(?:\\.git)?$`))?.[1];
};
