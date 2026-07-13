import * as fs from "node:fs";
import { parseEnv } from "node:util";

/** KEY=VALUE pairs from an env file, with the real environment taking precedence. */
export const loadEnv = (file: string): Record<string, string> => {
  const fromFile = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
  return { ...fromFile, ...process.env } as Record<string, string>;
};

/** Every ${NAME} referenced in text. */
export const placeholders = (text: string): string[] => [
  ...new Set([...text.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1])),
];
