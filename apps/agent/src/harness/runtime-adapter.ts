import {
  RuntimeClient,
  type BlockFindOptions,
  type BlockFindResult,
  type BlockGetResult,
  type BlockPosition,
  type BlockRegionResult,
  type CaptureViewOptions,
  type EntityListOptions,
  type EntityListResult,
  type RuntimeActor,
  type RuntimeInfo,
  type RuntimeOccurrence,
  type RuntimeObservation,
  type RuntimeTask,
  type RuntimeViewCapture,
  type TaskCancelResult,
  type TaskResult,
} from "@evicraft/runtime-sdk";

import type { HarnessConfig, HarnessSecrets } from "./config.js";
import { RuntimeConnectionError } from "./runtime-errors.js";
import {
  SemanticMenuTranslation,
  type CanonicalRuntimeResult,
} from "./semantic-menu.js";

export type { CanonicalRuntimeResult } from "./semantic-menu.js";

export interface HarnessReadyState {
  readonly actorId: string;
  readonly username: string;
  readonly lifecycle: "alive";
  readonly observationRevision: number;
}

export interface RuntimeSdkClient {
  runtimeInfo(): Promise<Pick<RuntimeInfo, "world_knowledge_profile">>;
  observe(): Promise<RuntimeObservation>;
  ensureBot(username?: string): Promise<RuntimeActor>;
  actorGet(): Promise<RuntimeActor | null>;
  startToolCall<Data extends Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): RuntimeTask<Data>;
  taskCancel(taskId: number): Promise<TaskCancelResult>;
  afterTicks(ticks: number): Promise<{ server_tick: number }>;
  blockGet(dimension: string, positions: BlockPosition[]): Promise<BlockGetResult>;
  blockFind(
    dimension: string, blockIdGlob: string, options?: BlockFindOptions,
  ): Promise<BlockFindResult>;
  blockRegion(dimension: string, min: BlockPosition, max: BlockPosition): Promise<BlockRegionResult>;
  entityList(options?: EntityListOptions): Promise<EntityListResult>;
  captureView(options?: CaptureViewOptions): Promise<RuntimeViewCapture>;
  onOccurrence(listener: (occurrence: RuntimeOccurrence) => void): () => void;
  onDisconnect(listener: (error: Error) => void): () => void;
  close(): void;
}


/** Concrete, Harness-specific semantic adapter over the reusable Runtime SDK. */
export class RuntimeAdapter {
  readonly #semantic: SemanticMenuTranslation;
  readonly #disconnectListeners = new Set<(error: Error) => void>();
  readonly #unsubscribeClientDisconnect: () => void;
  #disconnectFailure: Error | undefined;

  public constructor(private readonly client: RuntimeSdkClient) {
    this.#unsubscribeClientDisconnect = client.onDisconnect((error) => {
      this.invalidateConnection(error);
    });
    this.#semantic = new SemanticMenuTranslation({
      inspectGui: async (signal) => await this.rawCall("inspect_gui", {}, signal),
      transfer: async (args, signal) => await this.rawCall("transfer", args, signal),
    });
  }

  /** The Semantic Menu Translation over this Adapter's raw Menu primitives. */
  public get semantic(): SemanticMenuTranslation {
    return this.#semantic;
  }

  public static async connect(
    config: HarnessConfig,
    secrets: HarnessSecrets,
  ): Promise<RuntimeAdapter> {
    if (secrets.runtimeBearerToken === undefined) {
      throw new Error("EVICRAFT_RUNTIME_BEARER_TOKEN is required");
    }
    const client = await RuntimeClient.connect({
      url: config.runtime.url,
      bearerToken: secrets.runtimeBearerToken,
      connectTimeoutMs: config.runtime.connectTimeoutMs,
    });
    try {
      await client.runtimeInfo();
      return new RuntimeAdapter(client);
    } catch (error) {
      client.close();
      throw error;
    }
  }

  /** Read the actual connected World once when a Harness Run is provisioned. */
  public async worldKnowledgeProfile(signal?: AbortSignal): Promise<RuntimeInfo["world_knowledge_profile"]> {
    throwIfAborted(signal);
    let abort: (() => void) | undefined;
    try {
      const info = await new Promise<Pick<RuntimeInfo, "world_knowledge_profile">>((resolve, reject) => {
        // Stop waiting for this read without closing a borrowed Runtime connection.
        abort = () => reject(signal?.reason ?? new Error("Harness operation aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        this.client.runtimeInfo().then(resolve, reject);
      });
      throwIfAborted(signal);
      const profile = info.world_knowledge_profile;
      if (profile !== "grounded_evidence" && profile !== "loaded_world_state") {
        throw new Error(`Runtime reported unsupported World Knowledge Profile: ${String(profile)}`);
      }
      return profile;
    } finally {
      if (abort !== undefined) signal?.removeEventListener("abort", abort);
    }
  }

  public async observe(signal?: AbortSignal): Promise<RuntimeObservation> {
    throwIfAborted(signal);
    const abort = () => this.client.close();
    signal?.addEventListener("abort", abort, { once: true });
    try { return await this.client.observe(); }
    catch (error) { throwIfAborted(signal); throw error; }
    finally { signal?.removeEventListener("abort", abort); }
  }

  /** Turns the Bot and returns its first-person view from the World Run's camera client. */
  public async captureView(options: CaptureViewOptions, signal?: AbortSignal): Promise<RuntimeViewCapture> {
    throwIfAborted(signal);
    let abort: (() => void) | undefined;
    try {
      return await new Promise<RuntimeViewCapture>((resolve, reject) => {
        // Stop waiting for the frame without closing the shared Runtime connection; its late answer is ignored.
        abort = () => reject(signal?.reason ?? new Error("Harness operation aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        this.client.captureView(options).then(resolve, reject);
      });
    } finally {
      if (abort !== undefined) signal?.removeEventListener("abort", abort);
    }
  }

  public async resolveBot(
    username: string,
    signal?: AbortSignal,
  ): Promise<HarnessReadyState> {
    throwIfAborted(signal);
    let actor = await this.client.ensureBot(username);
    while (actor.lifecycle_state !== "alive") {
      throwIfAborted(signal);
      await abortableDelay(50, signal);
      actor = await this.client.actorGet() ?? actor;
    }
    return {
      actorId: actor.uuid,
      username: actor.name,
      lifecycle: "alive",
      observationRevision: actor.observation_revision,
    };
  }

  /** Attach without spawning, resetting, or changing an existing actor. */
  public async attachBot(actorId: string, signal?: AbortSignal): Promise<HarnessReadyState> {
    throwIfAborted(signal);
    const actor = await this.client.actorGet();
    if (actor === null || actor === undefined || actor.uuid !== actorId || actor.lifecycle_state !== "alive") {
      throw new Error(`Existing Bot ${actorId} is not available`);
    }
    return { actorId: actor.uuid, username: actor.name, lifecycle: "alive", observationRevision: actor.observation_revision };
  }

  public async call<Data extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CanonicalRuntimeResult<Data>> {
    return await this.rawCall<Data>(name, args, signal);
  }
  /**
   * Resolves once `ticks` game ticks have run. It only watches the Runtime clock: unlike the `wait` tool it
   * does not make game time pass. Rejects when the signal aborts or the connection closes.
   */
  public async afterTicks(ticks: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    let abort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(signal?.reason ?? new Error("Harness operation aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        this.client.afterTicks(ticks).then(() => resolve(), reject);
      });
    } finally {
      if (abort !== undefined) signal?.removeEventListener("abort", abort);
    }
  }

  public get disconnectFailure(): Error | undefined {
    return this.#disconnectFailure;
  }

  private invalidateConnection(error: Error): void {
    if (this.#disconnectFailure !== undefined) return;
    this.#disconnectFailure = error;
    for (const listener of this.#disconnectListeners) listener(error);
  }

  private async rawCall<Data extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CanonicalRuntimeResult<Data>> {
    if (this.#disconnectFailure !== undefined) throw this.#disconnectFailure;
    // A call whose signal is already aborted never reaches the Runtime. Throw
    // the raw abort reason as-is: distinguishing queued-not-started from a
    // started task's cancellation is the Harness layer's normalization job —
    // this adapter does not disguise one interruption shape as another.
    if (signal?.aborted === true) throw signal.reason ?? new Error(`${name} aborted before dispatch`);
    const task = this.client.startToolCall<Data>(name, args);
    let cancellationDeadline: ReturnType<typeof setTimeout> | undefined;
    let cancellationFailure: unknown;
    let rejectCancellation: (error: Error) => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const abort = () => {
      // A cancel acknowledgement is not task settlement. Drain the terminal response,
      // but bound an uncooperative/disconnected runtime and report it as unconfirmed.
      cancellationDeadline = setTimeout(() => {
        rejectCancellation(new RuntimeConnectionError(`Runtime task ${task.taskId} cancellation unconfirmed after 5000ms`, {
          cause: cancellationFailure ?? signal?.reason,
        }));
      }, 5000);
      void this.client.taskCancel(task.taskId).catch((error: unknown) => { cancellationFailure = error; });
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await Promise.race([task.result, cancelled]);
      return normalizeTaskResult(result);
    } catch (error) {
      if (error instanceof RuntimeConnectionError) {
        // Failed or unconfirmed native cleanup cannot authorize another body action.
        this.invalidateConnection(error);
        this.client.close();
      }
      throw error;
    } finally {
      if (cancellationDeadline !== undefined) clearTimeout(cancellationDeadline);
      signal?.removeEventListener("abort", abort);
    }
  }

  public blockGet(dimension: string, positions: BlockPosition[]): Promise<BlockGetResult> {
    return this.client.blockGet(dimension, positions);
  }

  public blockFind(
    dimension: string, blockIdGlob: string, options: BlockFindOptions = {},
  ): Promise<BlockFindResult> {
    return this.client.blockFind(dimension, blockIdGlob, options);
  }

  public blockRegion(
    dimension: string,
    min: BlockPosition,
    max: BlockPosition,
  ): Promise<BlockRegionResult> {
    return this.client.blockRegion(dimension, min, max);
  }

  public entityList(options: EntityListOptions = {}): Promise<EntityListResult> {
    return this.client.entityList(options);
  }

  public onOccurrence(listener: (occurrence: RuntimeOccurrence) => void): () => void {
    return this.client.onOccurrence(listener);
  }

  public onDisconnect(listener: (error: Error) => void): () => void {
    this.#disconnectListeners.add(listener);
    if (this.#disconnectFailure !== undefined) listener(this.#disconnectFailure);
    return () => { this.#disconnectListeners.delete(listener); };
  }

  public dispose(): void {
    this.#unsubscribeClientDisconnect();
    this.#disconnectListeners.clear();
  }

  public close(): void {
    this.dispose();
    this.client.close();
  }
}

export function normalizeTaskResult<Data extends Record<string, unknown>>(
  result: TaskResult<Data>,
): CanonicalRuntimeResult<Data> {
  const data = result.data ?? {} as Data;
  if (result.success) return { ok: true, message: result.message, data };
  if (data.failure_type === "internal") {
    throw new RuntimeConnectionError(`Runtime task cleanup failed: ${result.message}`, { cause: result });
  }
  if (result.interrupted === true || result.timed_out === true) {
    return { ok: false, error: "INTERRUPTED", message: result.message, data };
  }
  return { ok: false, error: "RUNTIME_FAILED", message: result.message, data };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason ?? new Error("aborted");
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
