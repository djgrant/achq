import { createVerify, generateKeyPairSync } from "node:crypto";

export type FakeApp = { slug: string; id: string; privateKey: string; publicKey: string; events: string[]; permissions: Record<string, string> };

export type FakeInstallation = {
  id: number;
  app: string;
  account: string;
  permissions: Record<string, string>;
  /** Every repo of the account the installation covers. */
  repos: string[];
  suspended?: boolean;
};

type Token = { app: string; installation: number; repos: string[]; permissions: Record<string, string> };
type Comment = { id: number; body: string; user: { login: string; type: string }; author_association: string; created_at: string };
type Issue = {
  number: number;
  title: string;
  body: string;
  user: { login: string; type: string };
  author_association: string;
  labels: { name: string }[];
  created_at: string;
  comments: Comment[];
  reactions: string[];
};

type Repo = { full_name: string; gitDir: string; default_branch: string; variables: Map<string, string> };

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

const git = (gitDir: string, args: string[]) => {
  const result = Bun.spawnSync(["git", "--git-dir", gitDir, ...args], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout : undefined;
};

export const makeApp = (slug: string, id: string, permissions: Record<string, string> = {}, events: string[] = []): FakeApp => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { slug, id, privateKey, publicKey, events, permissions };
};

export class FakeGitHub {
  installations: FakeInstallation[] = [];
  issues = new Map<string, Issue>();
  repos = new Map<string, Repo>();
  users = new Map<string, { id: number; login: string }>();
  tokens = new Map<string, Token>();
  minted: { installation: number; body: any }[] = [];
  requests: { method: string; path: string; auth: string }[] = [];
  /** User (OAuth) tokens: who they are, and the repos they can push to. */
  userTokens = new Map<string, { login: string; push: string[] }>();
  expiresAt: () => string = () => "2026-10-18T13:00:00Z";
  private server?: ReturnType<typeof Bun.serve>;
  private next = 1;
  private nextComment = 1;

  constructor(readonly apps: FakeApp[]) {}

  get url() {
    return `http://localhost:${this.server!.port}`;
  }

  keys() {
    return Object.fromEntries(this.apps.map((a) => [a.slug, { id: a.id, privateKey: a.privateKey }]));
  }

  start() {
    this.server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) });
    return this;
  }

  stop() {
    this.server?.stop(true);
  }

  /** Serves `repo`'s git data from the git repository at `gitDir` (bare or not). */
  addRepo(repo: string, gitDir: string, defaultBranch = "main") {
    this.repos.set(repo.toLowerCase(), { full_name: repo, gitDir, default_branch: defaultBranch, variables: new Map() });
  }

  /** A repository variable's value, parsed as JSON. */
  variable(repo: string, name: string) {
    const value = this.repos.get(repo.toLowerCase())?.variables.get(name);
    return value === undefined ? undefined : JSON.parse(value);
  }

  addIssue(repo: string, issue: Partial<Issue> & { number: number }) {
    this.issues.set(`${repo}#${issue.number}`, {
      title: "An issue",
      body: "",
      user: { login: "owner", type: "User" },
      author_association: "OWNER",
      labels: [],
      created_at: "2026-01-01T00:00:00Z",
      comments: [],
      reactions: [],
      ...issue,
    });
  }

  /** Without an `id`, it gets one higher than any so far, as GitHub's ids grow. */
  addComment(repo: string, number: number, comment: Partial<Comment> & { id?: number }) {
    const id = comment.id ?? this.nextComment;
    this.nextComment = Math.max(this.nextComment, id + 1);
    const added: Comment = {
      body: "",
      user: { login: "owner", type: "User" },
      author_association: "OWNER",
      created_at: "2026-01-01T00:00:00Z",
      ...comment,
      id,
    };
    this.issues.get(`${repo}#${number}`)!.comments.push(added);
    return added;
  }

  comments(repo: string, number: number) {
    return this.issues.get(`${repo}#${number}`)?.comments ?? [];
  }

  /** An issue's reactions, as `comment:<id>:<content>` or `issue:<content>`. */
  reactions(repo: string, number: number) {
    return this.issues.get(`${repo}#${number}`)?.reactions ?? [];
  }

  /** The App a JWT is from, if its signature checks out against that App's public key and it hasn't expired. */
  private jwtApp(auth: string): FakeApp | undefined {
    const m = /^Bearer (.+)\.(.+)\.(.+)$/.exec(auth);
    if (!m) return undefined;
    const [, header, payload, signature] = m;
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const app = this.apps.find((a) => a.id === claims.iss);
    if (!app || claims.exp < Date.now() / 1000) return undefined;
    const ok = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(app.publicKey, signature!, "base64url");
    return ok ? app : undefined;
  }

  private token(auth: string) {
    const m = /^token (.+)$/.exec(auth);
    return m ? this.tokens.get(m[1]!) : undefined;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization") ?? "";
    const path = url.pathname;
    const method = req.method;
    this.requests.push({ method, path, auth });
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const notFound = () => json({ message: "Not Found" }, 404);
    const page = <T>(items: T[]) => {
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const n = Number(url.searchParams.get("page") ?? 1);
      return items.slice((n - 1) * per, n * per);
    };
    let m: RegExpExecArray | null;

    // ── As the App ──
    if (path === "/app" || path.startsWith("/app/") || /\/installation$/.test(path)) {
      const app = this.jwtApp(auth);
      if (!app) return json({ message: "A JSON web token could not be decoded" }, 401);
      if (path === "/app" && method === "GET") return json({ slug: app.slug, id: Number(app.id), events: app.events, permissions: app.permissions });
      if (path === "/app/installations" && method === "GET")
        return json(page(this.installations.filter((i) => i.app === app.slug).map((i) => this.installationJson(i))));
      if ((m = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path)) && method === "GET") {
        // Like GitHub: found by the repo's owner, whether or not the installation selected this repo.
        const i = this.installations.find((i) => i.app === app.slug && i.account.toLowerCase() === m![1]!.toLowerCase());
        return i ? json(this.installationJson(i)) : notFound();
      }
      if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)) && method === "POST") {
        const i = this.installations.find((i) => i.app === app.slug && i.id === Number(m![1]));
        if (!i) return notFound();
        if (i.suspended) return json({ message: "This installation has been suspended" }, 403);
        const body: any = await req.json().catch(() => ({}));
        this.minted.push({ installation: i.id, body });
        const repos = body.repositories
          ? body.repositories.map((name: string) => i.repos.find((r) => r.split("/")[1] === name))
          : i.repos;
        if (repos.some((r: string | undefined) => !r)) return json({ message: "There is at least one repository that does not exist or is not accessible to the parent installation." }, 422);
        const permissions = body.permissions ?? i.permissions;
        for (const [name, level] of Object.entries<string>(permissions))
          if ((RANK[i.permissions[name] ?? ""] ?? 0) < (RANK[level] ?? 9)) return json({ message: `The permissions requested are not granted to this installation.` }, 422);
        const value = `ghs_${i.id}_${this.next++}`;
        this.tokens.set(value, { app: app.slug, installation: i.id, repos, permissions });
        return json({ token: value, expires_at: this.expiresAt(), permissions, repository_selection: "selected" }, 201);
      }
      return notFound();
    }

    // ── As an installation ──
    const token = this.token(auth);
    if (path === "/installation/repositories" && method === "GET") {
      if (!token) return json({ message: "Bad credentials" }, 401);
      const repos = token.repos.map((full_name) => ({ full_name }));
      return json({ total_count: repos.length, repositories: page(repos) });
    }
    if ((m = /^\/users\/([^/]+)$/.exec(path)) && method === "GET") {
      const login = decodeURIComponent(m[1]!);
      const app = this.apps.find((a) => `${a.slug}[bot]` === login);
      const user = this.users.get(login) ?? (app && { id: 90_000 + Number(app.id), login });
      return user ? json({ ...user, type: "Bot" }) : notFound();
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)(\/git\/.+|\/actions\/variables(?:\/[^/]+)?)?$/.exec(path))) {
      const repo = this.repos.get(m[1]!.toLowerCase());
      const person = this.userTokens.get(auth.replace(/^(token|Bearer) /, ""));
      if (person && repo && !m[2] && method === "GET") {
        const push = person.push.some((r) => r.toLowerCase() === repo.full_name.toLowerCase());
        return json({ full_name: repo.full_name, default_branch: repo.default_branch, private: true, permissions: { admin: false, maintain: false, push, triage: push, pull: true } });
      }
      if (!token || !repo || !token.repos.some((r) => r.toLowerCase() === m![1]!.toLowerCase())) return notFound();
      const rest = m[2] ?? "";
      const level = (name: string) => RANK[token.permissions[name] ?? ""] ?? 0;
      if (rest === "" && method === "GET") return json({ full_name: repo.full_name, default_branch: repo.default_branch, private: true });
      if (rest.startsWith("/git/")) {
        if (method !== "GET") return notFound();
        if (level("contents") < 1) return json({ message: "Resource not accessible by integration" }, 403);
        let n: RegExpExecArray | null;
        if ((n = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
          const sha = git(repo.gitDir, ["rev-parse", "-q", "--verify", `refs/heads/${decodeURIComponent(n[1]!)}`])?.toString().trim();
          return sha ? json({ ref: `refs/heads/${decodeURIComponent(n[1]!)}`, object: { sha, type: "commit" } }) : notFound();
        }
        if ((n = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
          const tree = git(repo.gitDir, ["rev-parse", "-q", "--verify", `${n[1]}^{tree}`])?.toString().trim();
          return tree ? json({ sha: n[1], tree: { sha: tree } }) : notFound();
        }
        if ((n = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
          const recursive = url.searchParams.get("recursive") === "1";
          const out = git(repo.gitDir, ["ls-tree", "-l", "-z", ...(recursive ? ["-r", "-t"] : []), n[1]!]);
          if (!out) return notFound();
          const tree = out
            .toString()
            .split("\0")
            .filter(Boolean)
            .map((line) => {
              const [meta, entryPath] = line.split("\t") as [string, string];
              const [mode, type, sha, size] = meta.split(/\s+/) as [string, string, string, string];
              return { path: entryPath, mode, type, sha, ...(type === "blob" && { size: Number(size) }) };
            });
          return json({ sha: n[1], tree, truncated: false });
        }
        if ((n = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest))) {
          const content = git(repo.gitDir, ["cat-file", "blob", n[1]!]);
          return content ? json({ sha: n[1], content: Buffer.from(content).toString("base64"), encoding: "base64", size: content.length }) : notFound();
        }
        return notFound();
      }
      // Repository variables need the "Variables" permission (`actions_variables`).
      if (level("actions_variables") < 2) return json({ message: "Resource not accessible by integration" }, 403);
      const name = rest.split("/")[3];
      if (name && method === "PATCH") {
        if (!repo.variables.has(name)) return notFound();
        repo.variables.set(name, ((await req.json()) as { value: string }).value);
        return new Response(null, { status: 204 });
      }
      if (!name && method === "POST") {
        const body = (await req.json()) as { name: string; value: string };
        if (repo.variables.has(body.name)) return json({ message: "Already exists" }, 409);
        repo.variables.set(body.name, body.value);
        return json({}, 201);
      }
      return notFound();
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(.+)$/.exec(path))) {
      const repo = m[1]!;
      const rest = m[2]!;
      if (!token || !token.repos.includes(repo)) return notFound();
      const canWrite = (RANK[token.permissions.issues ?? ""] ?? 0) >= 2;
      if (method !== "GET" && !canWrite) return json({ message: "Resource not accessible by integration" }, 403);
      let n: RegExpExecArray | null;
      if ((n = /^comments\/(\d+)\/reactions$/.exec(rest)) && method === "POST") {
        const id = Number(n[1]);
        const issue = [...this.issues.values()].find((i) => i.comments.some((c) => c.id === id));
        if (!issue) return notFound();
        issue.reactions.push(`comment:${id}:${((await req.json() as any)).content}`);
        return json({ id: 1 }, 201);
      }
      if (!(n = /^(\d+)(\/.*)?$/.exec(rest))) return notFound();
      const issue = this.issues.get(`${repo}#${n[1]}`);
      if (!issue) return notFound();
      const sub = n[2] ?? "";
      if (sub === "" && method === "GET") {
        const { comments, reactions, ...rest } = issue;
        return json({ ...rest, html_url: `https://github.com/${repo}/issues/${issue.number}` });
      }
      if (sub === "/comments" && method === "GET") return json(page(issue.comments));
      if (sub === "/comments" && method === "POST") {
        const { body } = (await req.json() as any);
        const bot = `${token.app}[bot]`;
        const added = this.addComment(repo, issue.number, { body, user: { login: bot, type: "Bot" }, author_association: "NONE", created_at: new Date().toISOString() });
        return json(added, 201);
      }
      if (sub === "/reactions" && method === "POST") {
        issue.reactions.push(`issue:${((await req.json() as any)).content}`);
        return json({ id: 1 }, 201);
      }
    }
    return notFound();
  }

  private installationJson(i: FakeInstallation) {
    return {
      id: i.id,
      account: { login: i.account },
      permissions: i.permissions,
      repository_selection: "selected",
      suspended_at: i.suspended ? "2026-01-01T00:00:00Z" : null,
    };
  }
}
