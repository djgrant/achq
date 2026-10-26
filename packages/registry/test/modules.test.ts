import { expect, test } from "bun:test";
import * as cloudflare from "@achq/cloudflare/infra";
import { achq } from "@achq/core";
import { Channel } from "@achq/github/infra";
import { Router } from "@achq/railway/infra";
import { INFRA_MODULES } from "../src/modules.ts";

test("the infra's imports are this checkout's modules", () => {
  const modules = INFRA_MODULES as Record<string, Record<string, unknown>>;
  expect(modules["@achq/core"]!.achq).toBe(achq);
  expect(modules["@achq/github/infra"]!.Channel).toBe(Channel);
  expect(modules["@achq/railway/infra"]!.Router).toBe(Router);
  expect(modules["@achq/cloudflare/infra"]!.Router).toBe(cloudflare.Router);
  expect(modules["@achq/cloudflare/infra"]!.Deployer).toBe(cloudflare.Deployer);
});
