import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createRouter, webhookSecret } from "./router.ts";

const key = "key";
const repo = "djgrant/gh-agent-test";

const delivery = (payload: object, event = "issue_comment", secret = webhookSecret(key, repo)) => {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Request("http://router/webhook", {
    method: "POST",
    headers: { "x-github-event": event, "x-hub-signature-256": signature, "content-type": "application/json" },
    body,
  });
};

const comment = (body: string) => ({ action: "created", repository: { full_name: repo }, comment: { body } });

/** A router whose forwards are recorded, answering with `statuses` in turn. */
const setup = (statuses: (number | Error)[]) => {
  const calls: { url: string; init: RequestInit }[] = [];
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const router = createRouter({
    key,
    trigger: "@claude",
    agentPort: 3000,
    delays: statuses.slice(1).map(() => 0),
    forward: async (url, init) => {
      calls.push({ url, init });
      const status = statuses[calls.length - 1];
      if (calls.length === statuses.length) setTimeout(done, 0);
      if (status instanceof Error) throw status;
      return new Response("", { status });
    },
  });
  return { router, calls, finished };
};

describe("router", () => {
  test("forwards a mention to the repo's service over the private network", async () => {
    const { router, calls, finished } = setup([202]);
    const res = await router(delivery(comment("@claude hi")));
    expect(res.status).toBe(202);
    await finished;
    expect(calls[0].url).toBe("http://djgrant-gh-agent-test.railway.internal:3000/webhook");
    expect((calls[0].init.headers as Record<string, string>)["x-hub-signature-256"]).toStartWith("sha256=");
  });

  test("retries while the service wakes", async () => {
    const { router, calls, finished } = setup([new Error("connection refused"), 502, 202]);
    await router(delivery(comment("@claude hi")));
    await finished;
    expect(calls.length).toBe(3);
  });

  test("doesn't wake a service for anything it wouldn't act on", async () => {
    const { router, calls } = setup([202]);
    expect(await (await router(delivery(comment("no mention")))).text()).toBe("skipped");
    expect(await (await router(delivery({ zen: "hi", repository: { full_name: repo } }, "ping"))).text()).toBe("skipped");
    expect(calls.length).toBe(0);
  });

  test("rejects a delivery signed with another repo's secret", async () => {
    const { router } = setup([202]);
    const res = await router(delivery(comment("@claude hi"), "issue_comment", webhookSecret(key, "someone/else")));
    expect(res.status).toBe(401);
  });
});
