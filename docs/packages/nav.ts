import type { DocCategory } from "@notation/docs/config";

export const packages: DocCategory = {
  label: "Packages",
  slug: "packages",
  sections: [
    {
      heading: "Entrypoints",
      icon: "terminal",
      links: [
        { label: "@achq/cli", slug: "packages/cli" },
        { label: "@achq/core", slug: "packages/core" },
      ],
    },
    {
      heading: "Plugins",
      icon: "cpu",
      links: [
        { label: "@achq/github", slug: "packages/github" },
        { label: "@achq/claude", slug: "packages/claude" },
        { label: "@achq/cloudflare", slug: "packages/cloudflare" },
        { label: "@achq/railway", slug: "packages/railway" },
        { label: "@achq/1password", slug: "packages/1password" },
      ],
    },
  ],
};
