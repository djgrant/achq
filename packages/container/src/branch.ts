/** Fills a branch template like `docs/{number}` from a thread's vars. */
export const fillBranch = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`The branch template \`${template}\` uses {${name}}, which the thread doesn't have`);
    return value;
  });
