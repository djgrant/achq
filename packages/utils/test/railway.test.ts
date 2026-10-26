import { afterEach, expect, test } from "bun:test";
import { OPERATIONS, Railway, RailwayError, rootField } from "../src/railway/index.ts";
import { nodes } from "../src/railway/operations.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

const answering = (body: string) => {
  server = Bun.serve({ port: 0, fetch: () => new Response(body, { status: 502 }) });
  return new Railway("t", `http://localhost:${server.port}/graphql/v2`);
};

test("each operation is keyed by the field it asks for, which is how the fake answers it", () => {
  for (const [key, operation] of Object.entries(OPERATIONS)) expect(rootField(operation.document)).toBe(key);
});

test("nodes unwraps a connection", () => {
  expect(nodes({ edges: [{ node: 1 }, { node: 2 }] })).toEqual([1, 2]);
});

test("a response that isn't JSON, or carries errors, is a RailwayError", async () => {
  await expect(answering("<html>bad gateway</html>").workspaces()).rejects.toThrow(new RailwayError("Railway: 502 <html>bad gateway</html>"));
  await expect(answering(JSON.stringify({ errors: [{ message: "a" }, { message: "b" }] })).workspaces()).rejects.toThrow("Railway: a; b");
});

test("an answer that isn't what the operation declares is a RailwayError naming the operation and where", async () => {
  await expect(answering(JSON.stringify({ data: { apiToken: { workspaces: [{ id: 1, name: "w" }] } } })).workspaces()).rejects.toThrow(
    new RailwayError("Railway apiToken: apiToken.workspaces.0.id: Invalid type: Expected string but received 1"),
  );
  await expect(answering(JSON.stringify({ data: {} })).createProject("p", "ws")).rejects.toThrow("Railway projectCreate: projectCreate: Invalid type: Expected Object but received undefined");
});

test("fields achq doesn't ask for pass", async () => {
  expect(await answering(JSON.stringify({ data: { apiToken: { workspaces: [{ id: "w", name: "w", plan: "pro" }] } } })).workspaces()).toEqual([{ id: "w", name: "w", plan: "pro" }]);
});

test("a project's default environment is production, or its first", async () => {
  const project = (names: string[]) => ({
    data: { project: { id: "p", name: "n", environments: { edges: names.map((name) => ({ node: { id: `e-${name}`, name } })) }, services: { edges: [] }, volumes: { edges: [] } } },
  });
  expect((await answering(JSON.stringify(project(["staging", "production"]))).readProject("p")).environmentId).toBe("e-production");
  expect((await answering(JSON.stringify(project(["staging"]))).readProject("p")).environmentId).toBe("e-staging");
  await expect(answering(JSON.stringify(project([]))).readProject("p")).rejects.toThrow("Railway project n has no environment");
});
