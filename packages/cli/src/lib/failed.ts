// What `achq status` says about deliveries the router couldn't make, and what
// `achq replay` did with them.
import { type FailedDelivery, type ReplayResult, threadKey } from "@achq/core";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Under the status table: each failed delivery's targets and why, or nothing when there are none. */
export const failedSection = (failed: FailedDelivery[]): string[] => {
  if (!failed.length) return [];
  const lines = failed.flatMap((f) => {
    const about = f.thread ? threadKey(f.thread) : (f.repo ?? "-");
    return f.targets.map((t) => `  ${f.delivery}  ${f.type}  ${about} → ${t.target}: ${t.error}`);
  });
  return ["", `${plural(failed.length, "delivery", "deliveries")} failed. Run \`achq replay\` to send ${failed.length === 1 ? "it" : "them"} again:`, ...lines];
};

export const formatReplay = ({ replayed, dropped }: ReplayResult): string[] => {
  if (!replayed.length && !dropped.length) return ["No delivery has failed"];
  return [
    ...(replayed.length ? [`Replaying ${plural(replayed.length, "delivery", "deliveries")}: ${replayed.join(", ")}. \`achq status\` shows any that fail again.`] : []),
    ...(dropped.length ? [`Dropped ${plural(dropped.length, "delivery", "deliveries")} whose repo or container is gone: ${dropped.join(", ")}`] : []),
  ];
};
