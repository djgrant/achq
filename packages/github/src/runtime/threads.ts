export const issueThreadId = (repo: string, number: number) => `${repo}#${number}`;

export const parseThreadId = (id: string) => {
  const m = /^([^/#]+)\/([^/#]+)#(\d+)$/.exec(id);
  if (!m) throw new Error(`Not a GitHub issue thread: ${id}`);
  return { owner: m[1]!, repo: m[2]!, full: `${m[1]}/${m[2]}`, number: Number(m[3]) };
};

/** For `{title}` in branch templates: lowercase words joined by dashes, at most 40 characters. */
export const slugify = (title: string, max = 40) =>
  title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
