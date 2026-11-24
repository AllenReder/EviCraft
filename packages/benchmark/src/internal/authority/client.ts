import { createHash, randomUUID } from "node:crypto";

import WebSocket from "ws";

import type { BenchmarkRun, BenchmarkSample, AuthorityActor, AuthorityActorState, AuthorityAdvancementDefinitions, AuthorityBlockGetResult, AuthorityBlockPosition, AuthorityBlockSetResult, AuthorityEvaluationFacts, AuthorityFactSection, AuthorityInfo, AuthorityInventory, AuthorityItemStack, AuthoritySnapshot, AuthoritySnapshotBlock, AuthoritySnapshotSelection, AuthorityTeleport, BenchmarkAuthority } from "../../index.js";

interface RpcResponse { readonly jsonrpc: "2.0"; readonly id: number; readonly result?: unknown; readonly error?: Readonly<{ readonly code: number; readonly message: string }>; }

class AuthorityRpcError extends Error {
  constructor(public readonly category: "timeout" | "closed" | "cancelled" | "send" | "remote", message: string) { super(message); }
}

export class BenchmarkAuthorityClient implements BenchmarkAuthority {
  readonly #pending = new Map<number, Readonly<{ resolve(value: unknown): void; reject(error: Error): void }>>();
  #nextId = 1;
  #closed = false;
  readonly #connectionId = randomUUID();
  #closeError = new AuthorityRpcError("closed", "Benchmark Authority client is closed");
  #samples: SampleQueue | undefined;
  private constructor(private readonly socket: WebSocket, private readonly timeoutMs = 30_000, private readonly mirror: (event: Readonly<Record<string, string | number>>) => Promise<void> = async () => {}) {
    socket.on("message", (wire) => this.#receive(String(wire)));
    socket.on("close", () => this.#fail(new Error("Benchmark Authority connection closed")));
    socket.on("error", (error) => this.#fail(error));
  }
  public static async connect(input: Readonly<{ url: string; bearerToken: string; timeoutMs?: number; handshakeTimeoutMs?: number; signal?: AbortSignal; mirror?: (event: Readonly<Record<string, string | number>>) => Promise<void> }>): Promise<BenchmarkAuthorityClient> {
    input.signal?.throwIfAborted();
    if (input.bearerToken.trim() === "") throw new Error("Benchmark Authority bearer token is required");
    const socket = new WebSocket(input.url, { handshakeTimeout: input.handshakeTimeoutMs ?? input.timeoutMs ?? 30_000, headers: { Authorization: `Bearer ${input.bearerToken}` } });
    let cancel: (() => void) | undefined;
    try {
      await new Promise<void>((resolvePromise, reject) => {
        cancel = () => { reject(input.signal?.reason); socket.terminate(); };
        input.signal?.addEventListener("abort", cancel, { once: true });
        socket.once("open", resolvePromise); socket.once("error", reject);
        socket.once("unexpected-response", (_request, response) => { response.resume(); reject(new Error(`Benchmark Authority handshake rejected with HTTP ${response.statusCode}`)); });
      });
      input.signal?.throwIfAborted();
    } catch (error) { socket.terminate(); throw error; }
    finally { if (cancel) input.signal?.removeEventListener("abort", cancel); }
    return new BenchmarkAuthorityClient(socket, input.timeoutMs, input.mirror);
  }
  public async info(timeoutMs?: number): Promise<AuthorityInfo> { return validateInfo(await this.#call("benchmark.info", {}, timeoutMs)); }
  public async getBlock(input: AuthorityBlockPosition): Promise<AuthorityBlockGetResult> { return validateBlockGet(await this.#call("world.block.get", snakePosition(input))); }
  public async setBlock(input: AuthorityBlockPosition & Readonly<{ blockId: string }>): Promise<AuthorityBlockSetResult> { return validateBlockSet(await this.#call("world.block.set", { ...snakePosition(input), block_id: input.blockId })); }
  public async getActor(): Promise<AuthorityActor> { return validateActor(await this.#call("actor.get", {})); }
  public async diagnostics(): Promise<unknown> { return this.#call("benchmark.diagnostics", {}); }

  public async getSnapshot(input: AuthoritySnapshotSelection): Promise<AuthoritySnapshot> { return validateSnapshot(await this.#call("benchmark.snapshot.get", { actor: input.actor, inventory: input.inventory, blocks: input.blocks.map(snakePosition), ...(input.evaluation ? { evaluation: true } : {}) })); }
  public async getAdvancementDefinitions(): Promise<AuthorityAdvancementDefinitions> { return validateAdvancementDefinitions(await this.#call("benchmark.advancement_definitions.get", {})); }
  public async teleportActor(input: AuthorityTeleport): Promise<AuthorityActor> { return validateActor(await this.#call("actor.teleport", snakePosition(input))); }
  public async createActor(username: string): Promise<AuthorityActor> { return validateActor(await this.#call("actor.create", { username })); }
  public async setRespawnPoint(input: AuthorityBlockPosition & { yaw?: number }): Promise<void> { await this.#call("actor.respawn.set", { dimension: input.dimension, x: input.x, y: input.y, z: input.z, yaw: input.yaw ?? 0 }); }
  public async giveItem(input: { itemId: string; count: number }): Promise<void> { await this.#call("actor.item.give", { item_id: input.itemId, count: input.count }); }
  public async setInventorySlot(input: { slot: number; itemId: string; count: number }): Promise<void> { await this.#call("actor.inventory.set", { slot: input.slot, item_id: input.itemId, count: input.count }); }
  public async setEquipment(input: { slot: "mainhand" | "offhand" | "head" | "chest" | "legs" | "feet"; itemId: string; count: number }): Promise<void> { await this.#call("actor.equipment.set", { slot: input.slot, item_id: input.itemId, count: input.count }); }
  public async executeMinecraftCommand(command: string): Promise<{ success: boolean; result: number }> {
    const value = record(await this.#call("world.command.execute", { command }));
    if (typeof value.success !== "boolean" || typeof value.result !== "number") throw new Error("Invalid command result");
    return { success: value.success, result: value.result };
  }
  /**
   * Starts the benchmark clock. The Runtime takes a sample every `sampleIntervalTicks` game ticks counted from
   * the returned start tick and each time the World Run comes to rest, holds the World Run on the budget tick
   * and then ends `samples()`.
   */
  public async startRun(input: Readonly<{ tickBudget: number; sampleIntervalTicks: number }>): Promise<BenchmarkRun> {
    if (this.#samples !== undefined) throw new Error("Benchmark run already started");
    const queue = this.#samples = new SampleQueue();
    const value = record(await this.#call("benchmark.run.start", { tick_budget: input.tickBudget, sample_interval_ticks: input.sampleIntervalTicks }));
    if (!Number.isSafeInteger(value.start_tick)) throw new Error("Benchmark Authority run start is invalid");
    return { startTick: value.start_tick as number, initial: validateSample(value.sample), samples: () => queue };
  }
  public async pauseTime(): Promise<void> { await this.#call("world.time.pause", {}); }
  public async resumeTime(): Promise<void> { await this.#call("world.time.resume", {}); }
  public async isTimePaused(): Promise<boolean> {
    const value = record(await this.#call("world.time.get", {}));
    if (typeof value.paused !== "boolean") throw new Error("Invalid time state");
    return value.paused;
  }
  public close(reason: "closed" | "cancelled" = "closed"): void {
    if (!this.#closed) { this.#fail(new AuthorityRpcError(reason, `Benchmark Authority client is ${reason}`)); this.socket.terminate(); }
  }
  async #call(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.#closed) throw this.#closeError;
    const id = this.#nextId++;
    const started = performance.now();
    const details = { connection_id: this.#connectionId, request_id: id, method, timeout_ms: timeoutMs };
    const mirror = (event: Readonly<Record<string, string | number>>) => this.mirror({ ...details, timestamp: new Date().toISOString(), duration_ms: performance.now() - started, pending: this.#pending.size, socket_state: this.socket.readyState, ...event });
    await mirror({ type: "authority_request", arguments_digest: digest(params) });
    try {
      if (this.#closed) throw this.#closeError;
      const result = await new Promise<unknown>((resolvePromise, reject) => {
        const timeout = setTimeout(() => { this.#pending.delete(id); reject(new AuthorityRpcError("timeout", `Benchmark Authority RPC timed out: ${method}`)); }, timeoutMs);
        let received = false;
        let sent = false;
        let response: unknown;
        const complete = () => { if (received && sent) { this.#pending.delete(id); clearTimeout(timeout); resolvePromise(response); } };
        const resolve = (value: unknown) => { if (received) return; received = true; response = value; complete(); };
        const fail = (error: Error) => { this.#pending.delete(id); clearTimeout(timeout); reject(error); };
        this.#pending.set(id, { resolve, reject: fail });
        try {
          this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (error) => {
            if (error) { this.#pending.delete(id); fail(new AuthorityRpcError("send", "Benchmark Authority send failed")); }
            else void mirror({ type: "authority_sent" }).then(() => { sent = true; complete(); }, fail);
          });
        } catch { this.#pending.delete(id); fail(new AuthorityRpcError("send", "Benchmark Authority send failed")); }
      });
      await mirror({ type: "authority_receipt", result_digest: digest(result) });
      return result;
    } catch (error) {
      try { await mirror({ type: "authority_failure", category: error instanceof AuthorityRpcError ? error.category : "remote" }); }
      catch (auditError) { throw new AggregateError([error, auditError], "Authority request and audit failed", { cause: error }); }
      throw error;
    }
  }
  #receive(wire: string): void {
    let value: unknown;
    try { value = JSON.parse(wire); } catch { return; }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const notification = value as Readonly<{ method?: unknown; params?: unknown }>;
    if (notification.method === "benchmark.sample") {
      try { this.#samples?.push(validateSample(notification.params)); }
      catch (error) { this.#samples?.end(error instanceof Error ? error : new Error(String(error))); }
      return;
    }
    if (notification.method === "benchmark.run.finished") { this.#samples?.end(); return; }
    const response = value as RpcResponse;
    if (response.jsonrpc !== "2.0" || !Number.isSafeInteger(response.id)) return;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    if (response.error !== undefined) {
      if (response.error === null || typeof response.error !== "object") pending.reject(new Error("Malformed Benchmark Authority RPC error"));
      else pending.reject(new Error(`Benchmark Authority RPC ${response.error.code}: ${response.error.message}`));
    } else pending.resolve(response.result);
  }
  #fail(error: Error): void {
    this.#closed = true;
    this.#closeError = error instanceof AuthorityRpcError ? error : new AuthorityRpcError("closed", error.message);
    for (const pending of this.#pending.values()) pending.reject(this.#closeError);
    this.#pending.clear();
    this.#samples?.end(this.#closeError);
  }

}

/** Samples in the order the Runtime took them; iteration ends after the budget tick, or throws if the connection is lost. */
class SampleQueue implements AsyncIterableIterator<BenchmarkSample> {
  readonly #ready: BenchmarkSample[] = [];
  #ended: Readonly<{ error?: Error }> | undefined;
  #wake: (() => void) | undefined;
  public push(sample: BenchmarkSample): void { if (this.#ended === undefined) { this.#ready.push(sample); this.#wake?.(); } }
  public end(error?: Error): void { this.#ended ??= error === undefined ? {} : { error }; this.#wake?.(); }
  public [Symbol.asyncIterator](): this { return this; }
  public async next(): Promise<IteratorResult<BenchmarkSample>> {
    for (;;) {
      const sample = this.#ready.shift();
      if (sample !== undefined) return { done: false, value: sample };
      if (this.#ended !== undefined) {
        if (this.#ended.error !== undefined) throw this.#ended.error;
        return { done: true, value: undefined };
      }
      await new Promise<void>(resolve => { this.#wake = resolve; });
      this.#wake = undefined;
    }
  }
}

function validateSample(value: unknown): BenchmarkSample {
  const elapsedTick = record(value).elapsed_tick;
  if (!Number.isSafeInteger(elapsedTick) || (elapsedTick as number) < 0) throw new Error("Benchmark Authority sample has an invalid elapsed tick");
  return { ...validateSnapshot(value), elapsedTick: elapsedTick as number };
}

function snakePosition(input: AuthorityBlockPosition): Record<string, unknown> { return { dimension: input.dimension, x: input.x, y: input.y, z: input.z, ...("yaw" in input ? { yaw: (input as AuthorityTeleport).yaw, pitch: (input as AuthorityTeleport).pitch } : {}) }; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function record(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Benchmark Authority response must be an object"); return value as Record<string, unknown>; }
function receipt(value: Record<string, unknown>): { fenceSequence: number; serverTick: number; gameTime: number } {
  if (!Number.isSafeInteger(value.fence_sequence) || !Number.isSafeInteger(value.server_tick)
      || !Number.isSafeInteger(value.game_time)) {
    throw new Error("Benchmark Authority response has an invalid receipt");
  }
  return { fenceSequence: value.fence_sequence as number, serverTick: value.server_tick as number, gameTime: value.game_time as number };
}
function validateInfo(value: unknown): AuthorityInfo {
  const object = record(value);
  const fields = ["build_version", "minecraft_version", "neoforge_version", "readiness", "world_knowledge_profile"] as const;
  if (!Number.isSafeInteger(object.protocol_version)) throw new Error("Benchmark Authority info has invalid protocol_version");
  for (const field of fields) if (typeof object[field] !== "string") throw new Error(`Benchmark Authority info has invalid ${field}`);
  if (!Number.isSafeInteger(object.grounded_block_expiry_ticks) || !Number.isSafeInteger(object.grounded_entity_expiry_ticks)
      || !Array.isArray(object.capabilities) || !object.capabilities.every((item) => typeof item === "string")) {
    throw new Error("Benchmark Authority info has invalid capabilities");
  }
  return {
    protocolVersion: object.protocol_version as number,
    buildVersion: object.build_version as string,
    minecraftVersion: object.minecraft_version as string,
    neoForgeVersion: object.neoforge_version as string,
    readiness: object.readiness as string,
    worldKnowledgeProfile: object.world_knowledge_profile as string,
    groundedBlockExpiryTicks: object.grounded_block_expiry_ticks as number,
    groundedEntityExpiryTicks: object.grounded_entity_expiry_ticks as number,
    capabilities: Object.freeze([...object.capabilities] as string[]),
    ...receipt(object),
  };
}
function validateBlockGet(value: unknown): AuthorityBlockGetResult {
  const object = record(value);
  if (typeof object.block_state !== "string") throw new Error("Benchmark Authority block get has invalid block_state");
  return { blockState: object.block_state, ...receipt(object) };
}
function validateBlockSet(value: unknown): AuthorityBlockSetResult {
  const object = record(value);
  if (typeof object.previous_block_state !== "string" || typeof object.current_block_state !== "string") {
    throw new Error("Benchmark Authority block set has invalid states");
  }
  return { previousBlockState: object.previous_block_state, currentBlockState: object.current_block_state, ...receipt(object) };
}
function validateActor(value: unknown): AuthorityActor {
  const object = record(value);
  return { ...validateActorState(object), ...receipt(object) };
}
function validateSnapshot(value: unknown): AuthoritySnapshot {
  const object = record(value);
  if (!Array.isArray(object.blocks)) throw new Error("Benchmark Authority snapshot has invalid blocks");
  if (object.inventory !== null && object.inventory !== undefined && typeof object.inventory !== "object") throw new Error("Benchmark Authority snapshot has invalid inventory");
  const actor = validateActorState(record(object.actor));
  const blocks = Object.freeze(object.blocks.map(validateSnapshotBlock));
  const deaths = object.actor_death_count;
  if (deaths !== undefined && (!Number.isSafeInteger(deaths) || (deaths as number) < 0)) throw new Error("Invalid actor death count");
  const portals = object.portal_activation_count;
  if (portals !== undefined && (!Number.isSafeInteger(portals) || (portals as number) < 0)) throw new Error("Invalid portal activation count");
  return { ...(deaths === undefined ? {} : {actorDeathCount: deaths as number}), ...(portals === undefined ? {} : {portalActivationCount: portals as number}), actor, inventory: object.inventory === null ? null : validateInventory(object.inventory), blocks, ...(object.evaluation === undefined ? {} : { evaluation: validateEvaluation(object.evaluation) }), ...receipt(object) };
}
function blockPosition(value: unknown): AuthorityBlockPosition {
  const object = record(value);
  if (typeof object.dimension !== "string" || !Number.isSafeInteger(object.x) || !Number.isSafeInteger(object.y) || !Number.isSafeInteger(object.z)) throw new Error("Invalid evaluation position");
  return { dimension: object.dimension, x: object.x as number, y: object.y as number, z: object.z as number };
}
function factSection<T>(value: unknown, parse: (value: unknown) => T): AuthorityFactSection<T> {
  const object = record(value);
  if (object.status === "unavailable" && typeof object.reason === "string") return { status: "unavailable", reason: object.reason };
  if (object.status === "ok") return { status: "ok", value: parse(object.value) };
  throw new Error("Invalid evaluation fact section");
}
function validateEvaluation(value: unknown): AuthorityEvaluationFacts {
  const object = record(value);
  return {
    location: factSection(object.location, raw => {
      const location = record(raw);
      if (typeof location.biome_id !== "string" || !Array.isArray(location.structures)) throw new Error("Invalid evaluation location");
      return { biomeId: location.biome_id, structuresContainingActor: location.structures.map(rawStructure => {
        const structure = record(rawStructure);
        if (typeof structure.id !== "string") throw new Error("Invalid evaluation structure");
        const bounds = record(structure.bounds);
        return { id: structure.id, bounds: { min: blockPosition(bounds.min), max: blockPosition(bounds.max) } };
      }) };
    }),
    advancements: factSection(object.advancements, raw => {
      if (!Array.isArray(raw)) throw new Error("Invalid evaluation advancements");
      return raw.map(entry => {
        const advancement = record(entry);
        if (typeof advancement.id !== "string" || typeof advancement.done !== "boolean" || !Array.isArray(advancement.criteria)) throw new Error("Invalid evaluation advancement");
        return { id: advancement.id, done: advancement.done, criteria: advancement.criteria.map(entry => {
          const criterion = record(entry);
          if (typeof criterion.name !== "string" || typeof criterion.done !== "boolean" || (criterion.obtained_at !== undefined && typeof criterion.obtained_at !== "string")) throw new Error("Invalid evaluation criterion");
          return { name: criterion.name, done: criterion.done, ...(criterion.obtained_at === undefined ? {} : { obtainedAt: criterion.obtained_at }) };
        }) };
      });
    }),
    nearbyPortals: factSection(object.nearby_portals, raw => {
      const scan = record(raw);
      if (!Array.isArray(scan.candidates)) throw new Error("Invalid portal scan");
      return { min: blockPosition(scan.min), max: blockPosition(scan.max), candidates: scan.candidates.map(rawCandidate => {
        const candidate = record(rawCandidate);
        if ((candidate.kind !== "nether" && candidate.kind !== "end") || typeof candidate.frame_complete !== "boolean" || typeof candidate.active !== "boolean" || !Array.isArray(candidate.evidence)) throw new Error("Invalid portal candidate");
        return { kind: candidate.kind, position: blockPosition(candidate.position), frameComplete: candidate.frame_complete, active: candidate.active, evidence: candidate.evidence.map(validateSnapshotBlock) };
      }) };
    }),
  };
}
function validateAdvancementDefinitions(value: unknown): AuthorityAdvancementDefinitions {
  const object = record(value);
  if (!Array.isArray(object.definitions)) throw new Error("Invalid advancement definitions");
  return { definitions: object.definitions.map(raw => {
    const definition = record(raw);
    if (typeof definition.id !== "string" || !Array.isArray(definition.criteria_names) || !definition.criteria_names.every(name => typeof name === "string")
      || !Array.isArray(definition.requirements) || !definition.requirements.every(group => Array.isArray(group) && group.every(name => typeof name === "string"))) throw new Error("Invalid advancement definition");
    return { id: definition.id, criteriaNames: definition.criteria_names as string[], requirements: definition.requirements as string[][] };
  }), ...receipt(object) };
}
function validateActorState(object: Record<string, unknown>): AuthorityActorState {
  if (object.present === false) return { present: false };
  if (object.present !== true || typeof object.uuid !== "string" || typeof object.name !== "string"
      || typeof object.lifecycle !== "string" || typeof object.dimension !== "string"
      || typeof object.yaw !== "number" || typeof object.pitch !== "number"
      || typeof object.health !== "number" || typeof object.food !== "number") {
    throw new Error("Benchmark Authority actor has invalid fields");
  }
  return {
    present: true, uuid: object.uuid, name: object.name, lifecycle: object.lifecycle,
    dimension: object.dimension, position: positionValue(object.position), yaw: object.yaw,
    pitch: object.pitch, health: object.health, food: object.food,
  };
}
function validateSnapshotBlock(value: unknown): AuthoritySnapshotBlock {
  const object = record(value);
  if (typeof object.dimension !== "string" || !Number.isSafeInteger(object.x) || !Number.isSafeInteger(object.y)
      || !Number.isSafeInteger(object.z) || typeof object.block_state !== "string") {
    throw new Error("Benchmark Authority snapshot has invalid block");
  }
  return { dimension: object.dimension, x: object.x as number, y: object.y as number, z: object.z as number, blockState: object.block_state };
}
function validateInventory(value: unknown): AuthorityInventory {
  const object = record(value);
  if (!Number.isSafeInteger(object.selected_hotbar_slot) || !Array.isArray(object.slots) || object.slots.length !== 36) throw new Error("Benchmark Authority inventory has invalid slots");
  const armor = record(object.armor);
  const slots = object.slots.map((value, index) => {
    const slot = record(value);
    if (!Number.isSafeInteger(slot.slot) || slot.slot !== index || !("item" in slot)) throw new Error("Benchmark Authority inventory slot is invalid");
    return { slot: index, item: slot.item === null ? null : itemStack(slot.item) };
  });
  return {
    selectedHotbarSlot: object.selected_hotbar_slot as number,
    slots: Object.freeze(slots),
    mainhand: optionalItemStack(object.mainhand),
    offhand: optionalItemStack(object.offhand),
    armor: { head: optionalItemStack(armor.head), chest: optionalItemStack(armor.chest), legs: optionalItemStack(armor.legs), feet: optionalItemStack(armor.feet) },
  };
}

function optionalItemStack(value: unknown): AuthorityItemStack | null {
  return value === null ? null : itemStack(value);
}

function itemStack(value: unknown): AuthorityItemStack {
  const object = record(value);
  if (typeof object.item_id !== "string" || !Number.isSafeInteger(object.count)
      || (object.durability !== undefined && typeof object.durability !== "object")
      || (object.components !== undefined && typeof object.components !== "string")) {
    throw new Error("Benchmark Authority item stack is invalid");
  }
  const components = object.components === undefined ? {} : { components: object.components };
  if (object.durability === undefined) return { itemId: object.item_id, count: object.count as number, ...components };
  const durability = record(object.durability);
  if (!Number.isSafeInteger(durability.remaining) || !Number.isSafeInteger(durability.maximum)) throw new Error("Benchmark Authority item durability is invalid");
  return { itemId: object.item_id, count: object.count as number, durability: { remaining: durability.remaining as number, maximum: durability.maximum as number }, ...components };
}
function positionValue(value: unknown): Readonly<{ x: number; y: number; z: number }> {
  const position = record(value);
  if (typeof position.x !== "number" || typeof position.y !== "number" || typeof position.z !== "number") throw new Error("Benchmark Authority actor has invalid position");
  return { x: position.x, y: position.y, z: position.z };
}
