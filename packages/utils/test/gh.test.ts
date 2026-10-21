import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { GitHub } from "../src/gh/index.ts";

// A tiny GitHub: each test sets the routes it answers, and every request is recorded.
type Route = (req: Request, url: URL) => Response | Promise<Response>;
let routes: Record<string, Route> = {};
let requests: { method: string; path: string; url: URL; auth: string | null; body: string }[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    requests.push({ method: req.method, path: url.pathname, url, auth: req.headers.get("authorization"), body: await req.clone().text() });
    const route = routes[`${req.method} ${url.pathname}`];
    return route ? route(req, url) : Response.json({ message: "Not Found" }, { status: 404 });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  routes = {};
  requests = [];
});

const baseUrl = `http://localhost:${server.port}`;
const gh = GitHub.connect({ token: "t", baseUrl });
const repo = gh.repo("o/r");

describe("auth", () => {
  test("sends its token, or none", async () => {
    routes["GET /users/u"] = () => Response.json({ id: 1, login: "u" });
    await gh.user("u");
    await GitHub.connect({ baseUrl }).user("u");
    expect(requests.map((r) => r.auth)).toEqual(["token t", null]);
  });

  test("as the App, each request carries a JWT signed by the App's key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    routes["GET /app"] = () => Response.json({ events: ["push"], permissions: { contents: "read" } });
    expect(await GitHub.connectAsApp("42", privateKey, { baseUrl }).app()).toEqual({ events: ["push"], permissions: { contents: "read" } });
    const [header, payload, signature] = requests[0]!.auth!.replace(/^bearer /i, "").split(".") as [string, string, string];
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature, "base64url")).toBe(true);
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()).iss).toBe("42");
  });
});

describe("a repo's git data", () => {
  const tree = (entries: object[], truncated = false) => () => Response.json({ sha: "t", tree: entries, truncated });

  test("headOf, subtree and listTree walk from a branch to a directory's files", async () => {
    routes["GET /repos/o/r/git/ref/heads%2Ffeature%2Fx"] = () => Response.json({ object: { sha: "c1" } });
    routes["GET /repos/o/r/git/commits/c1"] = () => Response.json({ sha: "c1", tree: { sha: "root" } });
    routes["GET /repos/o/r/git/trees/root"] = tree([{ path: "a", mode: "040000", type: "tree", sha: "ta" }]);
    routes["GET /repos/o/r/git/trees/ta"] = (_, url) =>
      url.searchParams.get("recursive") ? tree([{ path: "f", mode: "100644", type: "blob", sha: "b", size: 2 }])() : tree([{ path: "b", mode: "040000", type: "tree", sha: "tb" }])();
    expect(await repo.headOf("feature/x")).toBe("c1");
    expect(await repo.subtree("c1", "a")).toBe("ta");
    expect(await repo.subtree("c1", "a/b")).toBe("tb");
    expect(await repo.subtree("c1", "missing")).toBeUndefined();
    expect((await repo.listTree("ta")).map((e) => e.path)).toEqual(["f"]);
  });

  test("listTree refuses a truncated listing", async () => {
    routes["GET /repos/o/r/git/trees/big"] = tree([], true);
    await expect(repo.listTree("big", ".achq/")).rejects.toThrow(".achq/ has too many files for GitHub to list");
  });

  test("blob decodes base64", async () => {
    routes["GET /repos/o/r/git/blobs/b"] = () => Response.json({ content: Buffer.from("héllo").toString("base64"), encoding: "base64" });
    expect((await repo.blob("b")).toString("utf8")).toBe("héllo");
  });

  test("latestCommitTouching asks for the newest commit on the branch that touched the path", async () => {
    routes["GET /repos/o/r/commits"] = () => Response.json([{ sha: "c", commit: { committer: { date: "2026-01-01" } } }]);
    expect((await repo.latestCommitTouching("main", "a b/&c"))?.sha).toBe("c");
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({ sha: "main", per_page: "1", path: "a b/&c" });
  });
});

describe("a repo's variables, issues and access", () => {
  test("upsertVariable updates a variable, or creates it when PATCH 404s", async () => {
    const vars = new Map<string, string>();
    routes["PATCH /repos/o/r/actions/variables/V"] = async (req) => {
      if (!vars.has("V")) return Response.json({ message: "Not Found" }, { status: 404 });
      vars.set("V", ((await req.json()) as { value: string }).value);
      return new Response(null, { status: 204 });
    };
    routes["POST /repos/o/r/actions/variables"] = async (req) => {
      const { name, value } = (await req.json()) as { name: string; value: string };
      vars.set(name, value);
      return Response.json({}, { status: 201 });
    };
    routes["GET /repos/o/r/actions/variables/V"] = () => Response.json({ name: "V", value: vars.get("V") });
    expect(await repo.variable("W")).toBeUndefined();
    await repo.upsertVariable("V", "1");
    await repo.upsertVariable("V", "2");
    expect(await repo.variable("V")).toBe("2");
    expect(requests.filter((r) => r.method !== "GET").map((r) => r.method)).toEqual(["PATCH", "POST", "PATCH"]);
  });

  test("upsertVariable throws for refusals other than a 404", async () => {
    routes["PATCH /repos/o/r/actions/variables/V"] = () => Response.json({ message: "forbidden" }, { status: 403 });
    await expect(repo.upsertVariable("V", "1")).rejects.toMatchObject({ status: 403 });
    expect(requests.map((r) => r.method)).toEqual(["PATCH"]);
  });

  test("issueComments follows GitHub's pages", async () => {
    routes["GET /repos/o/r/issues/1/comments"] = (_, url) => {
      if (url.searchParams.get("page") === "2") return Response.json([{ id: 101 }]);
      const next = new URL(url);
      next.searchParams.set("page", "2");
      return Response.json(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })), { headers: { link: `<${next}>; rel="next"` } });
    };
    expect((await repo.issueComments(1)).length).toBe(101);
    expect(requests.map((r) => r.url.searchParams.get("per_page"))).toEqual(["100", "100"]);
  });

  test("react targets a comment or the issue", async () => {
    routes["POST /repos/o/r/issues/comments/5/reactions"] = () => Response.json({}, { status: 201 });
    routes["POST /repos/o/r/issues/7/reactions"] = () => Response.json({}, { status: 201 });
    await repo.react({ comment: 5 }, "eyes");
    await repo.react({ issue: 7 }, "eyes");
    expect(requests.map((r) => `${r.path} ${r.body}`)).toEqual(['/repos/o/r/issues/comments/5/reactions {"content":"eyes"}', '/repos/o/r/issues/7/reactions {"content":"eyes"}']);
  });

  test("canPush is false for any refusal", async () => {
    expect(await repo.canPush()).toBe(false);
    routes["GET /repos/o/r"] = () => Response.json({ id: 1, full_name: "o/r", default_branch: "main", permissions: { push: true } });
    expect(await repo.canPush()).toBe(true);
  });

  test("installation and publicApp are undefined for a 404", async () => {
    expect(await repo.installation()).toBeUndefined();
    expect(await gh.publicApp("private-app")).toBeUndefined();
  });
});

describe("names and auth", () => {
  test("logins compare case-insensitively", () => {
    expect(GitHub.sameLogin("NotationLabs", "notationlabs")).toBe(true);
  });

  test("cliToken takes GH_TOKEN from the env without asking gh", () => {
    expect(GitHub.cliToken({ GH_TOKEN: "from-env" })).toBe("from-env");
  });
});
