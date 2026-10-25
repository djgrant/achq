import { type FailedDelivery, type ReplayResult, threadKey } from "@achq/core";
import { text } from "@achq/utils/text";

/** `1 delivery`, `2 deliveries`. */
const deliveries = (n: number) => `${n} ${text.plural(n, "delivery", "deliveries")}`;

/** Under the status table: each failed delivery's targets and why, or nothing when there are none. */
export const failedSection = (failed: FailedDelivery[]) => {
  if (!failed.length) return [];
  const lines = failed.flatMap((f) => {
    const about = f.thread ? threadKey(f.thread) : (f.repo ?? "-");
    return f.targets.map((t) => `  ${f.delivery}  ${f.type}  ${about} → ${t.target}: ${t.error}`);
  });
  return ["", `${deliveries(failed.length)} failed. Run \`achq infra replay\` to send ${failed.length === 1 ? "it" : "them"} again:`, ...lines];
};

export const formatReplay = ({ replayed, dropped }: ReplayResult) => {
  if (!replayed.length && !dropped.length) return ["No delivery has failed"];
  return [
    ...(replayed.length ? [`Replaying ${deliveries(replayed.length)}: ${replayed.join(", ")}. \`achq infra status\` shows any that fail again.`] : []),
    ...(dropped.length ? [`Dropped ${deliveries(dropped.length)} whose repo or container is gone: ${dropped.join(", ")}`] : []),
  ];
};
