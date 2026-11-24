import WebSocket from "ws";

export interface RuntimeInfo {
  protocol_version: 4;
  build_version: string;
  minecraft_version: string;
  neoforge_version: string;
  readiness: "starting" | "ready";
  world_knowledge_profile: "grounded_evidence" | "loaded_world_state";
  grounded_block_expiry_ticks: number;
  grounded_entity_expiry_ticks: number;
  simulation_suspended: boolean;
  /**
   * The World Run advances only while a tool call is in progress, a `wait` is pending, or the Bot is dead or
   * respawning. Thinking between calls then costs no game time.
   */
  pause_when_idle: boolean;
}

export interface RuntimeActor {
  uuid: string;
  name: string;
  lifecycle_state: "starting" | "alive" | "dead" | "respawning";
  observation_revision: number;
}

export interface RuntimeObservation {
  observation_revision: number;
  server_tick: number;
  game_time: number;
}

/** One first-person frame rendered by the camera client after the Bot turned to the requested direction. */
export interface RuntimeViewCapture {
  media_type: "image/png";
  image_base64: string;
  width: number;
  height: number;
  dimension: string;
  eye: { x: number; y: number; z: number };
  /** Minecraft degrees: 0 faces south (+Z), 90 west (-X), 180 north (-Z), -90 east (+X). */
  yaw: number;
  /** Minecraft degrees: -90 looks straight up, 90 straight down. */
  pitch: number;
  server_tick: number;
  /** Present when the view was aimed at a block center. */
  target_block?: BlockPosition;
}

/** Either `yaw`/`pitch` or `target_block` (a block in the Bot's dimension whose center the Bot looks at). */
export interface CaptureViewOptions {
  yaw?: number;
  pitch?: number;
  target_block?: BlockPosition;
}

/** JSON-RPC error code of `observation.capture_view` when no view can be captured: no camera client or no Bot. */
export const CAMERA_UNAVAILABLE_ERROR_CODE = -32010;

/** A JSON-RPC error answered by the Runtime. */
export class RuntimeSdkError extends Error {
  constructor(readonly code: number, message: string) {
    super(`Runtime SDK error ${code}: ${message}`);
  }
}

/** One call got no response within its deadline. The connection stays open and a late response is ignored. */
export class RuntimeSdkTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number, detail = "") {
    super(`Runtime SDK ${method} timed out after ${timeoutMs}ms${detail}`);
    this.name = "RuntimeSdkTimeoutError";
  }
}

export interface BlockPosition {
  x: number;
  y: number;
  z: number;
}

/** Exact live block returned when an exact break's native first hit is another block. */
export interface ExactBreakOccludingBlock {
  position: BlockPosition;
  block_state: string;
}

export interface ExactBreakObservedDropEntity extends Record<string, unknown> {
  uuid: string;
  item_id: string;
  count: number;
}

export interface ExactBreakSuccessData extends Record<string, unknown> {
  position: BlockPosition;
  observed_drop_entities: ExactBreakObservedDropEntity[];
}

export interface ExactBreakInterruptionData extends Record<string, unknown> {
  position: BlockPosition;
}

export type ExactBreakFailureType =
  | "menu_open"
  | "target_not_known_block"
  | "target_changed"
  | "out_of_reach"
  | "occluded"
  | "unsupported_shape"
  | "unbreakable"
  | "no_effect";

export interface ExactBreakNonOccludedFailureData extends Record<string, unknown> {
  position: BlockPosition;
  failure_type: Exclude<ExactBreakFailureType, "occluded">;
}

export interface ExactBreakOccludedFailureData extends Record<string, unknown> {
  position: BlockPosition;
  failure_type: "occluded";
  /** Present only when the native first hit was a block, never inferred from message text. */
  occluding_block?: ExactBreakOccludingBlock;
}

export type ExactBreakFailureData =
  | ExactBreakNonOccludedFailureData
  | ExactBreakOccludedFailureData;

export type ExactBreakTaskData =
  | ExactBreakSuccessData
  | ExactBreakFailureData
  | ExactBreakInterruptionData;

export interface ExactBreakArguments extends Record<string, unknown> {
  position: BlockPosition;
}

interface BlockEvidenceBase {
  dimension: string;
  position: BlockPosition;
}

export type BlockEvidenceCell =
  | (BlockEvidenceBase & { state: "UNKNOWN" })
  | (BlockEvidenceBase & {
      state: "KNOWN_AIR";
      source: string;
      observed_tick: number;
      observation_revision: number;
    })
  | (BlockEvidenceBase & {
      state: "KNOWN_BLOCK";
      block_state: string;
      fluid: string;
      source: string;
      observed_tick: number;
      observation_revision: number;
    });

export interface BlockGetResult {
  operation: "block.get";
  cells: BlockEvidenceCell[];
}

export interface BlockFindResult {
  operation: "block.find";
  matches: Array<Extract<BlockEvidenceCell, { state: "KNOWN_BLOCK" }>>;
  has_more: boolean;
  complete: false;
}

export interface BlockFindOptions {
  origin?: BlockPosition;
  limit?: number;
}

export type BlockEvidencePaletteEntry =
  | { state: "UNKNOWN" }
  | {
      state: "KNOWN_AIR";
      source: string;
      observed_tick: number;
      observation_revision: number;
    }
  | {
      state: "KNOWN_BLOCK";
      block_state: string;
      fluid: string;
      source: string;
      observed_tick: number;
      observation_revision: number;
    };

export interface BlockRegionResult {
  operation: "block.region";
  dimension: string;
  min: BlockPosition;
  size: BlockPosition;
  palette: BlockEvidencePaletteEntry[];
  /** x changes fastest, followed by y, then z. */
  indices: number[];
  complete: boolean;
}

/** External entity evidence omits health; the Bot's own health is available through body state. */
export interface EntityTrack {
  uuid: string;
  dimension: string;
  entity_id: string;
  item_id?: string;
  item_count?: number;
  position: { x: number; y: number; z: number };
  state: "VISIBLE" | "KNOWN";
  source: string;
  observed_tick: number;
  observation_revision: number;
}

export interface EntityGetResult {
  operation: "entity.get";
  track: EntityTrack | null;
}

export interface EntityListOptions {
  dimension?: string;
  entityIdGlob?: string;
  itemIdGlob?: string;
}

export interface EntityListResult {
  operation: "entity.list";
  tracks: EntityTrack[];
  has_more: boolean;
}

export interface RuntimeToolDescriptor {
  execution: "body" | "query";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RuntimeToolList {
  tools: RuntimeToolDescriptor[];
}

export interface TaskResult<TData extends Record<string, unknown> = Record<string, unknown>> {
  success: boolean;
  message: string;
  /** Present on every result that is not a success: a stable code to branch on. */
  failure_type?: string;
  timed_out?: true;
  interrupted?: true;
  data?: TData;
  /** Server ticks the call spanned; their difference is the game time it cost. */
  start_tick: number;
  end_tick: number;
}

export interface RuntimeTask<TData extends Record<string, unknown> = Record<string, unknown>> {
  taskId: number;
  result: Promise<TaskResult<TData>>;
}

export interface TaskCancelResult {
  task_id: number;
  cancelled: boolean;
}

export interface RuntimeBodyState {
  readonly health: number;
  readonly max_health: number;
  readonly air: number;
  readonly max_air: number;
  readonly underwater: boolean;
  readonly in_lava: boolean;
  readonly on_fire: boolean;
  readonly suffocating: boolean;
  readonly intersecting_blocks: readonly BlockPosition[];
}

export interface RuntimeActorLifecycleState {
  readonly uuid: string;
  readonly name: string;
  readonly lifecycle_state: "starting" | "alive" | "dead" | "respawning";
}

export type RuntimeOccurrence =
  | Readonly<{
      type: "body_state_changed";
      sequence: number;
      server_tick: number;
      data: Readonly<RuntimeBodyState>;
    }>
  | Readonly<{
      type: "damage_received";
      sequence: number;
      server_tick: number;
      data: Readonly<{
        amount: number;
        health: number;
        max_health: number;
        damage_type: string;
      }>;
    }>
  | Readonly<{
      type: "actor_lifecycle_changed";
      sequence: number;
      server_tick: number;
      data: Readonly<RuntimeActorLifecycleState>;
    }>;

export interface RuntimeClientOptions {
  url?: string;
  bearerToken: string;
  connectTimeoutMs?: number;
  /** Deadline for every call except `tool.call`; defaults to 60 s. */
  requestTimeoutMs?: number;
  /**
   * Wall-clock limit for one `tool.call`. When it passes, the client asks the Runtime to cancel the task
   * and waits `requestTimeoutMs` for the task's own terminal result. Unset: no client-side limit, the
   * Runtime's tick deadlines bound each task.
   */
  toolTimeoutMs?: number;
  /** Cancels connection setup. Run cancellation remains owned by the caller. */
  signal?: AbortSignal;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RpcNotification {
  jsonrpc: "2.0";
  method: "runtime.occurrence";
  params: RuntimeOccurrence;
}

type RpcMethod = "runtime.info" | "actor.get" | "actor.create" | "observation.observe" | "observation.capture_view"
  | "runtime.time.await_tick" | "knowledge.query" | "tool.list" | "tool.call" | "task.cancel";

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class RuntimeClient {
  static readonly defaultUrl = "ws://127.0.0.1:8765/rpc";

  readonly #socket: WebSocket;
  readonly #pending = new Map<number, PendingCall>();
  readonly #occurrenceListeners = new Set<(occurrence: RuntimeOccurrence) => void>();
  readonly #disconnectListeners = new Set<(error: Error) => void>();
  #nextId = 1;
  #disconnectError: Error | undefined;

  private constructor(socket: WebSocket, private readonly requestTimeoutMs: number, private readonly toolTimeoutMs: number | undefined) {
    this.#socket = socket;
    socket.on("message", (wire) => this.#receive(wire.toString()));
    socket.on("close", () => this.#disconnect(new Error("Runtime SDK connection closed")));
    socket.on("error", (error) => this.#disconnect(error));
  }

  static async connect(options: RuntimeClientOptions): Promise<RuntimeClient> {
    if (options.bearerToken.trim().length === 0) {
      throw new Error("bearerToken is required");
    }
    const connectTimeoutMs = positiveTimeout(options.connectTimeoutMs, 30_000);
    const requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, 60_000);
    const toolTimeoutMs = options.toolTimeoutMs === undefined ? undefined : positiveTimeout(options.toolTimeoutMs, 0);
    options.signal?.throwIfAborted();
    const socket = new WebSocket(options.url ?? RuntimeClient.defaultUrl, {
      headers: { Authorization: `Bearer ${options.bearerToken}` },
      handshakeTimeout: connectTimeoutMs,
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("open", opened);
        socket.off("error", failed);
        socket.off("unexpected-response", unexpected);
        options.signal?.removeEventListener("abort", aborted);
      };
      const opened = () => { cleanup(); resolve(); };
      const failed = (error: Error) => {
        cleanup();
        socket.on("error", () => {});
        socket.terminate();
        reject(error);
      };
      const aborted = () => failed(options.signal?.reason instanceof Error
        ? options.signal.reason : new Error("Runtime SDK connection cancelled"));
      const unexpected = (_request: unknown, response: { statusCode: number; resume(): void }) => {
        response.resume();
        failed(new Error(`Runtime SDK handshake rejected with HTTP ${response.statusCode}`));
      };
      socket.once("open", opened);
      socket.once("error", failed);
      socket.once("unexpected-response", unexpected);
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) aborted();
    });
    return new RuntimeClient(socket, requestTimeoutMs, toolTimeoutMs);
  }

  async runtimeInfo(): Promise<RuntimeInfo> {
    const info = await this.#call<RuntimeInfo>("runtime.info");
    if (!isRecord(info) || info.protocol_version !== 4 || info.readiness !== "ready") {
      throw new Error("Runtime SDK requires a ready protocol-4 Runtime");
    }
    return info;
  }

  actorGet(): Promise<RuntimeActor | null> {
    return this.#call<RuntimeActor | null>("actor.get");
  }

  actorCreate(username: string): Promise<RuntimeActor> {
    return this.#call<RuntimeActor>("actor.create", { username });
  }

  async ensureBot(username = "bot"): Promise<RuntimeActor> {
    const existing = await this.actorGet();
    if (existing === null) return await this.actorCreate(username);
    if (existing.name.toLocaleLowerCase("en-US") === username.toLocaleLowerCase("en-US")) {
      return existing;
    }
    throw new Error(
      `Runtime Bot singleton already exists as ${existing.name}; requested ${username}`,
    );
  }

  observe(): Promise<RuntimeObservation> {
    return this.#call<RuntimeObservation>("observation.observe");
  }

  /** Turns the Bot and returns its first-person view; requires a camera client attached to the World Run. */
  captureView(options: CaptureViewOptions = {}): Promise<RuntimeViewCapture> {
    return this.#call<RuntimeViewCapture>("observation.capture_view", {
      ...(options.yaw === undefined ? {} : { yaw: options.yaw }),
      ...(options.pitch === undefined ? {} : { pitch: options.pitch }),
      ...(options.target_block === undefined ? {} : { target_block: options.target_block }),
    });
  }

  /** Resolves once the server tick passes `afterTick`. It only watches the clock: it does not make game time pass. */
  waitForTick(afterTick: number): Promise<{ server_tick: number }> {
    return this.#call("runtime.time.await_tick", { after_tick: afterTick });
  }

  /** Resolves once `ticks` further ticks have run. Like {@link waitForTick} it only watches the clock. */
  afterTicks(ticks: number): Promise<{ server_tick: number }> {
    return this.#call("runtime.time.await_tick", { ticks });
  }

  blockGet(dimension: string, positions: BlockPosition[]): Promise<BlockGetResult> {
    return this.#call<BlockGetResult>("knowledge.query", {
      operation: "block.get",
      dimension,
      positions,
    });
  }

  blockFind(
    dimension: string,
    blockIdGlob: string,
    options: BlockFindOptions = {},
  ): Promise<BlockFindResult> {
    return this.#call<BlockFindResult>("knowledge.query", {
      operation: "block.find",
      dimension,
      block_id_glob: blockIdGlob,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  }

  blockRegion(
    dimension: string,
    min: BlockPosition,
    max: BlockPosition,
  ): Promise<BlockRegionResult> {
    return this.#call<BlockRegionResult>("knowledge.query", {
      operation: "block.region",
      dimension,
      min,
      max,
    });
  }

  entityGet(uuid: string): Promise<EntityGetResult> {
    return this.#call<EntityGetResult>("knowledge.query", {
      operation: "entity.get",
      uuid,
    });
  }

  entityList(options: EntityListOptions = {}): Promise<EntityListResult> {
    return this.#call<EntityListResult>("knowledge.query", {
      operation: "entity.list",
      ...(options.dimension === undefined ? {} : { dimension: options.dimension }),
      ...(options.entityIdGlob === undefined
        ? {} : { entity_id_glob: options.entityIdGlob }),
      ...(options.itemIdGlob === undefined ? {} : { item_id_glob: options.itemIdGlob }),
    });
  }

  toolList(): Promise<RuntimeToolList> {
    return this.#call<RuntimeToolList>("tool.list");
  }

  toolCall(name: "break_block", args: ExactBreakArguments): Promise<TaskResult<ExactBreakTaskData>>;
  toolCall<TData extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<TaskResult<TData>>;
  toolCall<TData extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<TaskResult<TData>> {
    return this.#call<unknown>("tool.call", { name, arguments: args })
      .then((result) => this.#validateToolResult<TData>(name, args, result));
  }

  startToolCall(name: "break_block", args: ExactBreakArguments): RuntimeTask<ExactBreakTaskData>;
  startToolCall<TData extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): RuntimeTask<TData>;
  startToolCall<TData extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): RuntimeTask<TData> {
    const taskId = this.#nextId++;
    return {
      taskId,
      result: this.#callWithId<unknown>(
        taskId,
        "tool.call",
        { name, arguments: args },
      ).then((result) => this.#validateToolResult<TData>(name, args, result)),
    };
  }

  taskCancel(taskId: number): Promise<TaskCancelResult> {
    return this.#call<TaskCancelResult>("task.cancel", { task_id: taskId });
  }

  onOccurrence(listener: (occurrence: RuntimeOccurrence) => void): () => void {
    this.#occurrenceListeners.add(listener);
    return () => { this.#occurrenceListeners.delete(listener); };
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.#disconnectListeners.add(listener);
    if (this.#disconnectError !== undefined) listener(this.#disconnectError);
    return () => { this.#disconnectListeners.delete(listener); };
  }

  close(): void {
    this.#disconnect(new Error("Runtime SDK connection closed"));
    this.#socket.terminate();
  }

  #call<T>(
    method: RpcMethod,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const id = this.#nextId++;
    return this.#callWithId(id, method, params);
  }

  #callWithId<T>(
    id: number,
    method: RpcMethod,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (this.#disconnectError !== undefined) return Promise.reject(this.#disconnectError);
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (operation: () => void) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        operation();
      };
      const expire = (timeoutMs: number, detail?: string) =>
        finish(() => reject(new RuntimeSdkTimeoutError(method, timeoutMs, detail)));
      if (method === "runtime.time.await_tick") {
        // Waits for game time, which has no wall-clock bound.
      } else if (method !== "tool.call") {
        timer = setTimeout(() => expire(this.requestTimeoutMs), this.requestTimeoutMs);
      } else if (this.toolTimeoutMs !== undefined) {
        const toolTimeoutMs = this.toolTimeoutMs;
        timer = setTimeout(() => {
          // The call stays pending: a cancelled task still ends with its own interrupted result.
          void this.taskCancel(id).catch(() => {});
          timer = setTimeout(() => expire(toolTimeoutMs, "; the Runtime did not confirm cancellation"), this.requestTimeoutMs);
        }, toolTimeoutMs);
      }
      this.#pending.set(id, {
        resolve: value => finish(() => resolve(value as T)),
        reject: error => finish(() => reject(error)),
      });
      try {
        this.#socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), error => {
          if (error) this.#pending.get(id)?.reject(error);
        });
      } catch (error) {
        this.#pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #validateToolResult<TData extends Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
    result: unknown,
  ): TaskResult<TData> {
    if (!isRecord(result) || typeof result.success !== "boolean" || typeof result.message !== "string"
        || (result.data !== undefined && !isRecord(result.data))
        || (result.timed_out !== undefined && result.timed_out !== true)
        || (result.interrupted !== undefined && result.interrupted !== true)) {
      throw new Error("Runtime SDK received an invalid task result");
    }
    if (!isExactBreakCall(name, args)) return result as unknown as TaskResult<TData>;
    if (!isExactBreakResult(result)) {
      throw new Error("Runtime SDK received an invalid exact break result");
    }
    return result as unknown as TaskResult<TData>;
  }

  #receive(text: string): void {
    let message: RpcResponse | RpcNotification;
    try {
      message = JSON.parse(text) as RpcResponse | RpcNotification;
    } catch {
      this.#failPending(new Error("Runtime SDK returned invalid JSON"));
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      this.#protocolFailure(new Error("Runtime SDK returned an invalid RPC envelope"));
      return;
    }
    if ("method" in message && message.method === "runtime.occurrence") {
      const occurrence = parseRuntimeOccurrence(message.params);
      if (occurrence === undefined) {
        this.#protocolFailure(new Error("Runtime SDK received an invalid Runtime Occurrence"));
        return;
      }
      for (const listener of this.#occurrenceListeners) listener(occurrence);
      return;
    }
    const response = message as RpcResponse;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.error) {
      pending.reject(new RuntimeSdkError(response.error.code, response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #protocolFailure(error: Error): void {
    this.#disconnect(error);
    this.#socket.close();
  }


  #disconnect(error: Error): void {
    if (this.#disconnectError !== undefined) return;
    this.#disconnectError = error;
    this.#failPending(error);
    for (const listener of this.#disconnectListeners) listener(error);
  }
}

function isExactBreakCall(name: string, args: Record<string, unknown>): boolean {
  return name === "break_block" && isBlockPosition(args.position);
}

function parseRuntimeOccurrence(value: unknown): RuntimeOccurrence | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.sequence)
      || !Number.isSafeInteger(value.server_tick) || !isRecord(value.data)
      || !hasOnlyKeys(value, ["type", "sequence", "server_tick", "data"])) return undefined;
  const base = { sequence: value.sequence as number, server_tick: value.server_tick as number };
  if (value.type === "body_state_changed" && isRuntimeBodyState(value.data)) {
    return Object.freeze({ type: value.type, ...base, data: Object.freeze({
      health: value.data.health,
      max_health: value.data.max_health,
      air: value.data.air,
      max_air: value.data.max_air,
      underwater: value.data.underwater,
      in_lava: value.data.in_lava,
      on_fire: value.data.on_fire,
      suffocating: value.data.suffocating,
      intersecting_blocks: Object.freeze(value.data.intersecting_blocks.map((position) => Object.freeze({
        x: position.x, y: position.y, z: position.z,
      }))),
    }) });
  }
  if (value.type === "damage_received" && isDamageReceivedData(value.data)) {
    return Object.freeze({ type: value.type, ...base, data: Object.freeze({
      amount: value.data.amount,
      health: value.data.health,
      max_health: value.data.max_health,
      damage_type: value.data.damage_type,
    }) });
  }
  if (value.type === "actor_lifecycle_changed" && isRuntimeActorLifecycleState(value.data)) {
    return Object.freeze({ type: value.type, ...base, data: Object.freeze({
      uuid: value.data.uuid,
      name: value.data.name,
      lifecycle_state: value.data.lifecycle_state,
    }) });
  }
  return undefined;
}

function isRuntimeBodyState(value: Record<string, unknown>): value is Record<string, unknown> & RuntimeBodyState {
  return hasOnlyKeys(value, [
    "health", "max_health", "air", "max_air", "underwater", "in_lava", "on_fire",
    "suffocating", "intersecting_blocks",
  ]) && finiteNumber(value.health) && finiteNumber(value.max_health)
    && Number.isSafeInteger(value.air) && Number.isSafeInteger(value.max_air)
    && typeof value.underwater === "boolean" && typeof value.in_lava === "boolean"
    && typeof value.on_fire === "boolean" && typeof value.suffocating === "boolean"
    && Array.isArray(value.intersecting_blocks) && value.intersecting_blocks.every(isBlockPosition);
}

function isDamageReceivedData(value: Record<string, unknown>): value is Record<string, unknown> & {
  amount: number;
  health: number;
  max_health: number;
  damage_type: string;
} {
  return hasOnlyKeys(value, ["amount", "health", "max_health", "damage_type"])
    && finiteNumber(value.amount) && finiteNumber(value.health) && finiteNumber(value.max_health)
    && typeof value.damage_type === "string" && value.damage_type.length > 0;
}

function isRuntimeActorLifecycleState(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RuntimeActorLifecycleState {
  return hasOnlyKeys(value, ["uuid", "name", "lifecycle_state"])
    && typeof value.uuid === "string" && UUID_PATTERN.test(value.uuid)
    && typeof value.name === "string" && value.name.length > 0
    && (value.lifecycle_state === "starting" || value.lifecycle_state === "alive"
      || value.lifecycle_state === "dead" || value.lifecycle_state === "respawning");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isExactBreakResult(value: unknown): value is TaskResult<ExactBreakTaskData> {
  if (!isRecord(value) || typeof value.success !== "boolean" || typeof value.message !== "string"
      || !isRecord(value.data)) return false;
  if (value.success) return isExactBreakSuccessData(value.data);
  if (value.interrupted === true || value.timed_out === true) return hasOnlyKeys(value.data, ["position"])
    && isBlockPosition(value.data.position);
  return isExactBreakFailureData(value.data);
}

function isExactBreakSuccessData(data: Record<string, unknown>): boolean {
  return hasOnlyKeys(data, ["position", "observed_drop_entities"])
    && isBlockPosition(data.position)
    && Array.isArray(data.observed_drop_entities)
    && data.observed_drop_entities.every(isObservedDropEntity);
}

function isExactBreakFailureData(data: Record<string, unknown>): boolean {
  if (!isBlockPosition(data.position) || typeof data.failure_type !== "string") return false;
  const nonOccluded = new Set<Exclude<ExactBreakFailureType, "occluded">>([
    "menu_open", "target_not_known_block", "target_changed", "out_of_reach",
    "unsupported_shape", "unbreakable", "no_effect",
  ]);
  if (data.failure_type === "occluded") {
    return hasOnlyKeys(data, ["position", "failure_type", "occluding_block"])
      && (data.occluding_block === undefined || isExactBreakOccludingBlock(data.occluding_block));
  }
  return nonOccluded.has(data.failure_type as Exclude<ExactBreakFailureType, "occluded">)
    && hasOnlyKeys(data, ["position", "failure_type"]);
}

function isExactBreakOccludingBlock(value: unknown): value is ExactBreakOccludingBlock {
  return isRecord(value) && hasOnlyKeys(value, ["position", "block_state"])
    && isBlockPosition(value.position) && typeof value.block_state === "string" && value.block_state.length > 0;
}

function isObservedDropEntity(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["uuid", "item_id", "count"])
    && typeof value.uuid === "string" && typeof value.item_id === "string"
    && typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count > 0;
}

function isBlockPosition(value: unknown): value is BlockPosition {
  return isRecord(value) && hasOnlyKeys(value, ["x", "y", "z"])
    && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y) && Number.isSafeInteger(value.z);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("Runtime SDK timeout must be a positive integer");
  return timeout;
}
