import * as fs from "node:fs";
import * as path from "node:path";

export type IssueState = {
  session?: string;
  /** The newest comment already given to the session. */
  lastCommentId: number;
  bodySha?: string;
  status: "idle" | "running" | "interrupted";
};

export const readState = (file: string): IssueState =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { lastCommentId: 0, status: "idle" };

export const writeState = (file: string, state: IssueState) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
};
