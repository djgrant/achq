// How `achq up` turns the infra's resources into a graph of live objects. Each
// platform implements the infra resources it hosts as expanders; resources
// reach each other only through handles, never through a platform's internals.
import type { Contribution, Graph, Node, Run } from "@achq/reconcile";
import type { Resource } from "../model/resources.ts";

/** A secret as other resources see it: never its value. */
export type SecretRef = {
  /** Its name in the store. */
  name: string;
  /** What a service's variable holds to use it. */
  ref: string;
  /** Changes when its value does, so whatever uses it can redeploy. */
  digest: string;
};

export type SecretLocation = "store" | "legacy";

/** Where an infra keeps its secrets. Services refer to them; only the store holds their values. */
export interface SecretStore {
  ref(name: string): string;
  /** A `legacy` location means it was found somewhere older, and writing it moves it into the store. */
  read(name: string): Promise<{ value: string; location: SecretLocation } | undefined>;
  write(name: string, value: string): Promise<void>;
}

/** Variables another resource gives the router, and the secrets they refer to. */
export type RouterEnv = { values: Record<string, string>; secrets?: SecretRef[] };

/** The router's public base URL and AGENT_WEBHOOK_KEY, for signed admin requests. */
export type RouterAccess = { base: string; key: string };

/** What a router offers the resources that use it, whatever platform hosts it. */
export interface RouterHandle {
  readonly publicUrl: Node<string>;
  /** AGENT_WEBHOOK_KEY. */
  readonly key: Node<SecretRef>;
  readonly secrets: Node<SecretStore>;
  /** Variables other resources give the router, e.g. an App's credential or the deployer's URL. */
  readonly env: Contribution<Node<RouterEnv>>;
  /** Waits until a deploy this run started is live. */
  live(run: Run): Promise<void>;
  /** Undefined until the router exists. */
  access(run: Run): Promise<RouterAccess | undefined>;
}

export interface Expansion {
  readonly graph: Graph;
  /** Another resource's handle, expanding it first if need be. */
  handle<H>(resource: Resource): H;
}

/** Adds an infra resource's live objects to the graph, and returns the handle others use it through. */
export interface Expander<R extends Resource = any, H = unknown> {
  readonly resource: abstract new (...args: any[]) => R;
  expand(resource: R, expansion: Expansion): H;
}
