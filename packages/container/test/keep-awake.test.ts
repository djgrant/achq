import { afterEach, expect, test } from "bun:test";
import { keepAwake } from "../src/keep-awake.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

test("pings ACHQ_KEEP_AWAKE_URL only when the platform sets it", async () => {
  expect(keepAwake({})).toBeUndefined();
  expect(keepAwake({ ACHQ_KEEP_AWAKE_URL: "" })).toBeUndefined();
  const hits: string[] = [];
  server = Bun.serve({ port: 0, fetch: (req) => (hits.push(new URL(req.url).pathname), new Response("ok")) });
  const ping = keepAwake({ ACHQ_KEEP_AWAKE_URL: `http://localhost:${server.port}/` })!;
  await ping();
  expect(hits).toEqual(["/"]);
});
