import { describe, expect, test } from "bun:test";
import type { CredentialsResponse } from "@achq/core";
import { containerSecret } from "@achq/core/secrets";
import { signedHeaders } from "@achq/core/signing";
import { key, repo, serve, fakeContainer, config, deployed } from "./harness.ts";

describe("credentials", () => {
  const ask = (container: string) => ({ repo, container });

  test("a container gets credentials for its own policies, and one client credential per source", async () => {
    const r = await deployed();
    const res = await r.asContainer(repo, "dev", "/credentials", ask("dev"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CredentialsResponse;
    expect(body.credentials.map((c) => c.value)).toEqual(["token:code", "token:shared"]);
    expect(body.credentials.every((c) => c.scope.repo === repo)).toBe(true);
    // dev's two workspaces share a source: one client credential.
    expect(body.channels.map((c) => c.value)).toEqual([`client:app:${repo}`]);

    const docs = (await (await r.asContainer(repo, "docsbox", "/credentials", ask("docsbox"))).json()) as CredentialsResponse;
    expect(docs.credentials.map((c) => c.value)).toEqual(["token:docs-read"]);
  });

  test("a wrong secret, another repo's container, or an old timestamp is rejected", async () => {
    const r = await deployed();
    const other = fakeContainer("dev", "acme/gadgets");
    await r.admin("PUT", "/admin/repos/acme/gadgets", { ...config(other, other), repo: "acme/gadgets" });
    // docsbox's secret, asking as dev.
    expect((await r.asContainer(repo, "docsbox", "/credentials", ask("dev"))).status).toBe(401);
    // acme/gadgets' dev, asking for acme/widgets' dev.
    expect((await r.asContainer("acme/gadgets", "dev", "/credentials", ask("dev"))).status).toBe(401);
    // A captured request, replayed ten minutes later.
    expect((await r.asContainer(repo, "dev", "/credentials", ask("dev"), Date.now() - 10 * 60_000)).status).toBe(401);
    // Signed for another path, sent to /credentials.
    const body = JSON.stringify(ask("dev"));
    const headers = signedHeaders(containerSecret(key, repo, "dev"), "POST", "/other", body);
    expect((await fetch(`${r.priv}/credentials`, { method: "POST", body, headers })).status).toBe(401);
    // A container the repo doesn't have, with a genuine secret for that name.
    expect((await r.asContainer(repo, "ghost", "/credentials", ask("ghost"))).status).toBe(404);
  });

  test("the public port doesn't serve credentials", async () => {
    const r = await deployed();
    expect((await r.asContainer(repo, "dev", "/credentials", ask("dev"), undefined, r.pub)).status).toBe(404);
  });
});
