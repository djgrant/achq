import { type EnvValues, type Input, type Output, type Placement, type Service as AchqService } from "@achq/core";
import type { InstanceSettings } from "@achq/utils/railway/model";
import { BUN_IMAGE, VOLUME } from "./constants.ts";
import { Deployment, fingerprint } from "./deployment.ts";
import { hostServiceName, privateUrl } from "./names.ts";
import { Service } from "./service.ts";
import { Variables } from "./variables.ts";

/**
 * Runs `pkg` (e.g. `@achq/router`) at `version` from npm, with Bun's cache on
 * the volume, which a wake keeps, so only a new version is downloaded. Railway
 * splits the command like a shell, without running one.
 */
export const startCommand = (pkg: string, version: string) => `env BUN_INSTALL_CACHE_DIR=${VOLUME}/bun-cache bunx ${pkg}@${version}`;

/** Where one of achq's own services runs on Railway: its service, in `at`, and its deploy. */
export class ServiceParts implements Placement {
  readonly name: string;
  readonly dataDir = VOLUME;
  readonly service: Service;
  private readonly settings: InstanceSettings;
  private readonly at: { projectId: Input<string>; environmentId: Input<string>; serviceId: Input<string> };

  constructor(
    private readonly owner: AchqService,
    at: { projectId: Input<string>; environmentId: Input<string> },
    private readonly own: { wait: boolean },
  ) {
    this.name = hostServiceName(owner.name);
    // Its settings' key order is part of the deploy's fingerprint: reordering them redeploys.
    this.settings = { source: { image: BUN_IMAGE }, startCommand: startCommand(owner.package, owner.version), healthcheckPath: "/", sleepApplication: owner.sleeps };
    this.service = new Service(
      "service",
      { at, name: this.name, settings: this.settings, volume: VOLUME, ...(owner.public && { publicPort: owner.port }) },
      { parent: owner },
    );
    this.at = { ...at, serviceId: this.service.out("serviceId") };
  }

  privateUrl(port: number) {
    return privateUrl(this.name, port);
  }

  group(name: string, values: EnvValues) {
    return new Variables(name, { at: this.at, service: this.name, values }, { parent: this.owner });
  }

  resources(groups: Variables[], variables: Output<Record<string, string>>) {
    const deploy = new Deployment(
      "deploy",
      { at: this.at, service: this.name, fingerprint: variables.map((v) => fingerprint({ settings: this.settings, variables: v })), wait: this.own.wait },
      { parent: this.owner },
    );
    return [this.service, ...groups, deploy];
  }
}
