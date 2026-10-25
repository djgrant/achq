import { expect, test } from "bun:test";
import * as cloudflare from "@achq/cloudflare/infra";
import { Channel } from "@achq/github/infra";
import { Router } from "@achq/railway/infra";
import { INFRA_MODULES } from "../src/modules.ts";

test("the infra's import has the infra sides", () => {
  const infra = INFRA_MODULES["achq/infra"] as { github: { Channel: unknown }; railway: { Router: unknown }; cloudflare: { Router: unknown; Deployer: unknown } };
  expect(infra.github.Channel).toBe(Channel);
  expect(infra.railway.Router).toBe(Router);
  expect(infra.cloudflare.Router).toBe(cloudflare.Router);
  expect(infra.cloudflare.Deployer).toBe(cloudflare.Deployer);
});
