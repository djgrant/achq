import { afterEach, expect, test } from "bun:test";
import { Cloudflare, CloudflareError } from "../src/cloudflare/index.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

/** An account whose API answers every request with `result`. */
const answering = (result: unknown, extra: Record<string, unknown> = {}) => {
  server = Bun.serve({ port: 0, fetch: () => Response.json({ success: true, errors: [], result, ...extra }) });
  return new Cloudflare("t", "acct", `http://localhost:${server.port}/client/v4`);
};

test("a result that isn't what the operation declares is a CloudflareError naming the operation and where", async () => {
  await expect(answering({ name: "w" }).workers.get("w")).rejects.toThrow(
    new CloudflareError("Cloudflare getWorker: result.id: Invalid input: expected string, received undefined", 200),
  );
  await expect(answering([{ id: "v1", containers: [{ class_name: "Service" }] }]).workers.versions("w")).rejects.toThrow(
    "Cloudflare listWorkerVersions: result.0.containers.0.images: Invalid input: expected record, received undefined",
  );
  await expect(answering([], { result_info: { cursor: 1 } }).kv.keys("ns", "")).rejects.toThrow("Cloudflare listKvKeys: result_info.cursor: Invalid input: expected string, received number");
});

test("fields achq doesn't read pass", async () => {
  expect(await answering({ id: "tag", name: "w", created_on: "today" }).workers.get("w")).toEqual({ id: "tag", name: "w", created_on: "today" });
});
