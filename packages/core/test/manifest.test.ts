import { describe, expect, test } from "bun:test";
import { ManifestInput, RepoManifest, validateManifest } from "../src/model/manifest.ts";
import * as v from "valibot";

const base: RepoManifest = {
  policies: [{ name: "code", policy: { provider: "github", source: "a" } }],
  containers: [{ name: "dev", image: "./Dockerfile", policies: ["code"], files: {} }],
  workspaces: [{ name: "issues", container: "dev", threads: { channel: "github", source: "a" }, branch: "issue-{number}", base: "main" }],
  agents: [{ name: "coder", runtime: "claude" }],
  triggers: [{ name: "mention", event: { channel: "github", source: "a" }, agent: "coder" }],
};
const copy = (): RepoManifest => JSON.parse(JSON.stringify(base));

describe("validateManifest", () => {
  test("rejects extra fields, bad names, missing tags, non-finite data and size limits", () => {
    expect(validateManifest(copy())).toEqual(base);
    expect(() => validateManifest({ ...copy(), extra: 1 })).toThrow("The config's manifest is invalid at extra");
    expect(() => validateManifest({ ...copy(), agents: [{ name: "Bad Name", runtime: "claude" }] })).toThrow("agents.0.name");
    expect(() => validateManifest({ ...copy(), workspaces: [{ ...base.workspaces[0], threads: { source: "x" } }] })).toThrow(`needs "channel"`);
    expect(() => validateManifest({ ...copy(), policies: [{ name: "code", policy: { provider: "" } }] })).toThrow(`needs "provider"`);
    expect(() => validateManifest({ ...copy(), policies: [{ name: "code", policy: { provider: "p", n: Infinity } }] })).toThrow("policies.0.policy");
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `c${i}`, image: "x", policies: [], files: {} }));
    expect(() => validateManifest({ ...copy(), containers: many })).toThrow("invalid at containers");
  });

  test("rejects duplicate names within a kind, but not across kinds", () => {
    expect(() => validateManifest({ ...copy(), agents: [{ name: "dev", runtime: "claude" }], triggers: [] })).not.toThrow();
    expect(() => validateManifest({ ...copy(), containers: [...base.containers, ...base.containers] })).toThrow('Two containers are named "dev"');
    expect(() => validateManifest({ ...copy(), policies: [...base.policies, ...base.policies] })).toThrow('Two policies are named "code"');
  });

  test("rejects references to what isn't declared", () => {
    const ghost = (patch: Partial<RepoManifest>) => () => validateManifest({ ...copy(), ...patch });
    expect(ghost({ policies: [] })).toThrow(`container dev refers to policy "code", which isn't declared in this config`);
    expect(ghost({ workspaces: [{ ...base.workspaces[0]!, container: "x" }] })).toThrow(`workspace issues refers to container "x"`);
    expect(ghost({ agents: [] })).toThrow(`trigger mention refers to agent "coder"`);
  });

  test("needs at least one container", () => {
    expect(() => validateManifest({ ...copy(), containers: [], workspaces: [] })).toThrow("The config declares no containers");
  });
});

describe("the manifest's two roles", () => {
  test("as stored, unknown keys a newer version added pass through, and the input's limits don't apply", () => {
    const newer = { ...copy(), extra: 1, agents: [{ name: "Not A Name", runtime: "claude", model: "x" }], containers: Array(21).fill(base.containers[0]) };
    expect(v.parse(RepoManifest, newer)).toEqual(newer);
    expect(v.safeParse(ManifestInput, newer).success).toBe(false);
  });
});
