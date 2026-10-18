export const openInBrowser = async (url: string) => {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  Bun.spawnSync([opener, url], { stdout: "ignore", stderr: "ignore" });
};
