import { expect, test } from "bun:test";
import { inbound, outbound, workerUrl } from "../src/routes.ts";
import type { WorkerSettings } from "../src/settings.ts";

const router: WorkerSettings = { name: "achq-router", port: 8080, publicPort: 8080, sleeps: false, restartOnChange: true, image: "cloudflare/debian-trixie", instance: "standard-1", workersDev: "acme.workers.dev" };
const deployer: WorkerSettings = { ...router, name: "achq-deployer", port: 3000, publicPort: undefined };
const isKey = (key: string) => key === "k";

test("the public reaches only a public port; achq's Workers reach any port with the internal key", () => {
  expect(inbound(new Headers(), router, isKey)).toEqual({ port: 8080 });
  // A public request can't pick its port.
  expect(inbound(new Headers({ "x-achq-port": "8081" }), router, isKey)).toEqual({ port: 8080 });
  expect(inbound(new Headers(), deployer, isKey)).toEqual({ refuse: 404 });
  expect(inbound(new Headers({ "x-achq-internal-key": "k", "x-achq-port": "8081" }), router, isKey)).toEqual({ port: 8081 });
  expect(inbound(new Headers({ "x-achq-internal-key": "wrong", "x-achq-port": "8081" }), deployer, isKey)).toEqual({ refuse: 401 });
  expect(inbound(new Headers({ "x-achq-internal-key": "k" }), deployer, isKey)).toEqual({ refuse: 400 });
});

test("a container's requests to achq.internal go to its own Worker's store, keep-awake and archive, or to another Worker's port", () => {
  expect(outbound("store.achq.internal")).toEqual({ to: "store" });
  expect(outbound("awake.achq.internal")).toEqual({ to: "awake" });
  expect(outbound("archive.achq.internal")).toEqual({ to: "archive" });
  expect(outbound("8081.achq-router.achq.internal")).toEqual({ to: "worker", worker: "achq-router", port: 8081 });
  expect(outbound("achq-router.achq.internal")).toEqual({ to: "unknown" });
  expect(workerUrl("achq-router", router, "/credentials?x=1")).toBe("https://achq-router.acme.workers.dev/credentials?x=1");
});
