// The parts of the Workers runtime the achq Worker uses, typed here so the
// repo's typecheck covers it without Cloudflare's own types. Wrangler bundles
// it against the real runtime.

declare module "cloudflare:workers" {
  export type ContainerStartupOptions = {
    image?: string;
    containerSnapshot?: { id: string };
    env?: Record<string, string>;
    entrypoint?: string[];
    enableInternet: boolean;
    instance?: string;
    labels?: Record<string, string>;
  };

  export interface ExecOutput {
    stdout: ArrayBuffer;
    stderr: ArrayBuffer;
    exitCode: number;
  }

  export interface Container {
    readonly running: boolean;
    readonly images: Record<string, string>;
    start(options: ContainerStartupOptions): void;
    destroy(reason?: unknown): Promise<void>;
    /** Settles when it stops: rejects with `exitCode` when its command fails. */
    monitor(): Promise<void>;
    setInactivityTimeout(ms: number): Promise<void>;
    snapshotContainer(options: { name?: string }): Promise<{ id: string; size: number; name?: string }>;
    exec(command: string[], options?: { env?: Record<string, string>; user?: string; cwd?: string }): Promise<{ output(): Promise<ExecOutput> }>;
    getTcpPort(port: number): { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
    interceptOutboundHttp(target: string, worker: Fetcher): Promise<void>;
  }

  export interface Fetcher {
    fetch(input: string | Request, init?: RequestInit): Promise<Response>;
  }

  export interface DurableObjectStorage {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T>(options: { prefix: string }): Promise<Map<string, T>>;
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  }

  export interface DurableObjectStub<T> extends Fetcher {
    // RPC: each of the object's methods, returning a promise.
    [method: string]: any;
  }

  export interface DurableObjectNamespace<T = unknown> {
    idFromName(name: string): unknown;
    get(id: unknown): DurableObjectStub<T> & T;
  }

  /** The Worker's own entrypoints, made from its exports. */
  export interface Exports {
    Service: DurableObjectNamespace<any>;
    Outbound(options: { props: unknown }): Fetcher;
  }

  export interface DurableObjectState {
    readonly container?: Container;
    readonly storage: DurableObjectStorage;
    readonly exports: Exports;
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
    waitUntil(promise: Promise<unknown>): void;
    /** Resets the object: what it's in the middle of throws, and the next call starts a new one. */
    abort(reason?: string): never;
  }

  /** The version metadata binding: which version of the Worker this is, and when it was made. */
  export interface WorkerVersionMetadata {
    readonly id: string;
    readonly tag: string;
    readonly timestamp: string;
  }

  export interface ExecutionContext {
    readonly exports: Exports;
    waitUntil(promise: Promise<unknown>): void;
  }

  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }

  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly ctx: ExecutionContext;
    protected readonly env: Env;
    constructor(ctx: ExecutionContext, env: Env);
  }

  export interface R2ObjectBody {
    readonly body: ReadableStream;
    readonly size: number;
  }

  export interface R2Bucket {
    get(key: string): Promise<R2ObjectBody | null>;
    put(key: string, value: ReadableStream): Promise<unknown>;
  }
}

/** A stream of a stated length, which R2 takes a streamed upload as. */
declare class FixedLengthStream {
  constructor(length: number);
  readonly readable: ReadableStream;
  readonly writable: WritableStream;
}
