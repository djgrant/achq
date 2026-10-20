import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt, ghToken, GitHub, GitHubClient, GitHubError, PAGE_SIZE, repoKey, sameLogin, sameRepo, splitRepo } from "../src/gh/index.ts";

// A tiny GitHub: each test sets the routes it answers, and every request is recorded.
type Route = (req: Request, url: URL) => Response | Promise<Response>;
let routes: Record<string, Route> = {};
let requests: { method: string; path: string; auth: string | null; ua: string | null; body: string }[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    requests.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get("authorization"), ua: req.headers.get("user-agent"), body: await req.clone().text() });
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
const gh = GitHub.connect("token t", { baseUrl });
const repo = gh.repo("o/r");

describe("GitHubClient", () => {
  test("sends auth, the API version and the user agent, which are options", async () => {
    routes["GET /x"] = () => Response.json({ ok: true });
    await new GitHubClient("token a", { baseUrl, userAgent: "tester" }).request("GET", "/x");
    expect(requests[0]).toMatchObject({ auth: "token a", ua: "tester" });
    await new GitHubClient("", { baseUrl }).request("GET", "/x");
    expect(requests[1]).toMatchObject({ auth: null, ua: "achq" });
  });

  test("find is undefined for a 404 and throws a GitHubError for other failures", async () => {
    routes["GET /boom"] = () => new Response("nope", { status: 500 });
    expect(await gh.client.find("GET", "/missing")).toBeUndefined();
    const error = (await gh.client.find("GET", "/boom").catch((e) => e)) as GitHubError;
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.message).toBe("GitHub GET /boom: 500 nope");
    expect(error.route).toBe("/boom");
  });

  test("paginate asks for full pages until one comes back short", async () => {
    routes["GET /items"] = (_, url) => {
      const page = Number(url.searchParams.get("page"));
      return Response.json({ items: Array.from({ length: page === 1 ? PAGE_SIZE : 3 }, (_, i) => i) });
    };
    const items = await gh.client.paginate<number>("/items", (page) => page.items);
    expect(items.length).toBe(PAGE_SIZE + 3);
    expect(requests.map((r) => r.path)).toEqual([`/items?per_page=${PAGE_SIZE}&page=1`, `/items?per_page=${PAGE_SIZE}&page=2`]);
  });
});

describe("a repo's git data", () => {
  const tree = (entries: object[], truncated = false) => () => Response.json({ sha: "t", tree: entries, truncated });

  test("headOf, subtree and listTree walk from a branch to a directory's files", async () => {
    routes["GET /repos/o/r/git/ref/heads/feature%2Fx"] = () => Response.json({ object: { sha: "c1" } });
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

  test("latestCommitTouching encodes the branch and the path", async () => {
    routes["GET /repos/o/r/commits"] = () => Response.json([{ sha: "c", commit: { committer: { date: "2026-01-01" } } }]);
    expect((await repo.latestCommitTouching("main", "a b/&c"))?.sha).toBe("c");
    expect(requests[0]!.path).toBe("/repos/o/r/commits?sha=main&per_page=1&path=a%20b%2F%26c");
  });
});

describe("a repo's variables, issues and access", () => {
  test("upsertVariable updates a variable, or creates it when PATCH 404s", async () => {
    const vars = new Map<string, string>();
    routes["PATCH /repos/o/r/actions/variables/V"] = async (req) => {
      if (!vars.has("V")) return new Response(null, { status: 404 });
      vars.set("V", ((await req.json()) as { value: string }).value);
      return new Response(null, { status: 204 });
    };
    routes["POST /repos/o/r/actions/variables"] = async (req) => {
      const { name, value } = (await req.json()) as { name: string; value: string };
      vars.set(name, value);
      return new Response(null, { status: 201 });
    };
    routes["GET /repos/o/r/actions/variables/V"] = () => Response.json({ name: "V", value: vars.get("V") });
    expect(await repo.variable("W")).toBeUndefined();
    await repo.upsertVariable("V", "1");
    await repo.upsertVariable("V", "2");
    expect(await repo.variable("V")).toBe("2");
    expect(requests.filter((r) => r.method !== "GET").map((r) => r.method)).toEqual(["PATCH", "POST", "PATCH"]);
  });

  test("upsertVariable throws for refusals other than a 404", async () => {
    routes["PATCH /repos/o/r/actions/variables/V"] = () => new Response("forbidden", { status: 403 });
    await expect(repo.upsertVariable("V", "1")).rejects.toThrow("GitHub PATCH /repos/o/r/actions/variables/V: 403 forbidden");
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
  test("repo names split, and compare case-insensitively", () => {
    expect(splitRepo("Owner/Name")).toEqual({ owner: "Owner", name: "Name" });
    expect(sameRepo("Owner/Name", "owner/name")).toBe(true);
    expect(repoKey("Owner/Name")).toBe("owner/name");
    expect(sameLogin("NotationLabs", "notationlabs")).toBe(true);
  });

  test("appJwt is signed by the App's key and lasts nine minutes", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const now = 1_700_000_000_000;
    const [header, payload, signature] = appJwt(42, privateKey, now).split(".") as [string, string, string];
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature, "base64url")).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: "42" });
  });

  test("ghToken takes GH_TOKEN from the env without asking gh", () => {
    expect(ghToken({ GH_TOKEN: "from-env" })).toBe("from-env");
  });
});
