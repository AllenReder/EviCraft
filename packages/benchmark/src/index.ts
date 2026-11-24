export type Json = null | boolean | number | string | readonly Json[] | Readonly<{ readonly [key: string]: Json }>;

export type WorldSource = Readonly<{ kind: "generated"; seed: string }> | Readonly<{ kind: "copied_snapshot"; worldDirectory: string }>;
export interface WorldRunRequest {
  readonly source: WorldSource;
  readonly worldKnowledgeProfile: "grounded_evidence" | "loaded_world_state";
  readonly groundedBlockExpiryTicks?: number;
  readonly groundedEntityExpiryTicks?: number;
  /** Full angle of the grounded cone of sight around the look direction; 360, the default, sees every direction. */
  readonly groundedFieldOfViewDegrees?: number;
}

export interface AuthorityFenceReceipt { readonly fenceSequence: number; readonly serverTick: number; readonly gameTime: number; }
export interface BenchmarkAuthority {
  info(): Promise<AuthorityInfo>;
  getBlock(input: AuthorityBlockPosition): Promise<AuthorityBlockGetResult>;
  setBlock(input: AuthorityBlockPosition & Readonly<{ blockId: string }>): Promise<AuthorityBlockSetResult>;
  getActor(): Promise<AuthorityActor>;
  getSnapshot(input: AuthoritySnapshotSelection): Promise<AuthoritySnapshot>;
  getAdvancementDefinitions(): Promise<AuthorityAdvancementDefinitions>;
  teleportActor(input: AuthorityTeleport): Promise<AuthorityActor>;
  close(): void;
}
export interface AuthorityInfo extends AuthorityFenceReceipt { readonly protocolVersion: number; readonly buildVersion: string; readonly minecraftVersion: string; readonly neoForgeVersion: string; readonly readiness: string; readonly worldKnowledgeProfile: string; readonly groundedBlockExpiryTicks: number; readonly groundedEntityExpiryTicks: number; readonly capabilities: readonly string[]; }
export interface AuthorityBlockPosition { readonly dimension: string; readonly x: number; readonly y: number; readonly z: number; }
export interface AuthorityBlockGetResult extends AuthorityFenceReceipt { readonly blockState: string; }
export interface AuthorityBlockSetResult extends AuthorityFenceReceipt { readonly previousBlockState: string; readonly currentBlockState: string; }
export type AuthorityActorState =
  | Readonly<{ present: false }>
  | Readonly<{ present: true; uuid: string; name: string; lifecycle: string; dimension: string; position: Readonly<{ x: number; y: number; z: number }>; yaw: number; pitch: number; health: number; food: number }>;
export type AuthorityActor = AuthorityActorState & AuthorityFenceReceipt;
export interface AuthorityTeleport { readonly dimension: string; readonly x: number; readonly y: number; readonly z: number; readonly yaw: number; readonly pitch: number; }
export interface AuthorityItemStack { readonly itemId: string; readonly count: number; readonly durability?: Readonly<{ remaining: number; maximum: number }>; readonly components?: string; }
export interface AuthorityInventorySlot { readonly slot: number; readonly item: AuthorityItemStack | null; }
export interface AuthorityInventory { readonly selectedHotbarSlot: number; readonly slots: readonly AuthorityInventorySlot[]; readonly mainhand: AuthorityItemStack | null; readonly offhand: AuthorityItemStack | null; readonly armor: Readonly<{ head: AuthorityItemStack | null; chest: AuthorityItemStack | null; legs: AuthorityItemStack | null; feet: AuthorityItemStack | null }>; }
export interface AuthoritySnapshotSelection { readonly actor: true; readonly inventory: true; readonly blocks: readonly AuthorityBlockPosition[]; readonly evaluation?: true; }
export interface AuthoritySnapshotBlock extends AuthorityBlockPosition { readonly blockState: string; }
export type AuthorityFactSection<T> = Readonly<{ status: "ok"; value: T }> | Readonly<{ status: "unavailable"; reason: string }>;
export interface AuthorityStructureBounds { readonly min: AuthorityBlockPosition; readonly max: AuthorityBlockPosition; }
export interface AuthorityLocatedStructure { readonly id: string; readonly bounds: AuthorityStructureBounds; }
export interface AuthorityAdvancementCriterion { readonly name: string; readonly done: boolean; readonly obtainedAt?: string; }
export interface AuthorityAdvancementProgress { readonly id: string; readonly done: boolean; readonly criteria: readonly AuthorityAdvancementCriterion[]; }
export interface AuthorityAdvancementDefinition { readonly id: string; readonly criteriaNames: readonly string[]; readonly requirements: readonly (readonly string[])[]; }
export interface AuthorityAdvancementDefinitions extends AuthorityFenceReceipt { readonly definitions: readonly AuthorityAdvancementDefinition[]; }
export interface AuthorityPortalCandidate { readonly kind: "nether" | "end"; readonly position: AuthorityBlockPosition; readonly frameComplete: boolean; readonly active: boolean; readonly evidence: readonly AuthoritySnapshotBlock[]; }
export interface AuthorityPortalScan { readonly min: AuthorityBlockPosition; readonly max: AuthorityBlockPosition; readonly candidates: readonly AuthorityPortalCandidate[]; }
export interface AuthorityEvaluationFacts {
  readonly location: AuthorityFactSection<Readonly<{ biomeId: string; structuresContainingActor: readonly AuthorityLocatedStructure[] }>>;
  readonly advancements: AuthorityFactSection<readonly AuthorityAdvancementProgress[]>;
  readonly nearbyPortals: AuthorityFactSection<AuthorityPortalScan>;
}
export interface AuthoritySnapshot extends AuthorityFenceReceipt {
  /** Native frame activations since server start; excludes generated destination portals. */
  readonly portalActivationCount?: number;
  /** Runtime Bot deaths since server start, including deaths followed by native respawn. */
  readonly actorDeathCount?: number;
  readonly actor: AuthorityActorState;
  readonly inventory: AuthorityInventory | null;
  readonly blocks: readonly AuthoritySnapshotBlock[];
  readonly evaluation?: AuthorityEvaluationFacts;
}

export * from "./task.js";
export { createLocalTaskPlatform, type LocalTaskConfiguration, type TaskHarnessConnection } from "./local-task-platform.js";
export { createProcessHarness, type HarnessTaskFile, type ProcessHarnessConfiguration } from "./process-harness.js";
