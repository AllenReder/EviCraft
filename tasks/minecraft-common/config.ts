import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import type { AuthorityTeleport, Json } from "@evicraft/benchmark";
import { observationSchemaVersion } from "./run.ts";

export interface SnapshotManifest {
  readonly revision: string;
  readonly seed: string;
  readonly sha256: string;
  readonly spawn: AuthorityTeleport;
  readonly feasibility: { readonly status: "pending" | "verified"; readonly receipt: string | null };
}

/** Content identity excludes only Minecraft's process lock, which changes on each load. */
export async function snapshotDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(relative: string) {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.name === "session.lock") continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(name);
      else {
        const bytes = await readFile(join(directory, name));
        hash.update(`${name}\0${bytes.length}\0`).update(bytes);
      }
    }
  }
  await visit("");
  return hash.digest("hex");
}

/** A task config file, shared by every Minecraft task; relative paths resolve against the file's directory. */
export interface TaskConfigInput {
  readonly serverTemplatePath: string;
  readonly serverCommand: readonly string[];
  /** A frozen world: a directory with `manifest.json` and `world/`, such as `tasks/minecraft-survival/snapshots/seed-100-v1`. */
  readonly snapshotPath: string;
  readonly profile?: "grounded_evidence" | "loaded_world_state";
  readonly tickBudget?: number;
  /** Game ticks between scoring samples; defaults to 20. */
  readonly sampleIntervalTicks?: number;
  /** Game time advances only while the Bot acts, waits, or is dead or respawning; defaults to true. */
  readonly pauseWhenIdle?: boolean;
  readonly groundedBlockExpiryTicks?: number;
  readonly groundedEntityExpiryTicks?: number;
  /** Full angle, in degrees, of G's cone of sight around the look direction; defaults to 360, every direction. */
  readonly groundedFieldOfViewDegrees?: number;
  readonly deathPolicy?: "respawn";
  /** First-person camera client attached to the World Run; `clientTemplatePath` is a prepared camera client template. `null` means none. */
  readonly camera?: {
    readonly clientTemplatePath: string; readonly viewDistance?: number; readonly width?: number; readonly height?: number;
  } | null;
  /**
   * The agent under test. `command` runs in `workingDirectory` (default: the directory of this config file);
   * `config` belongs to the Harness and is passed through unread.
   */
  readonly harness: { readonly command: readonly string[]; readonly workingDirectory?: string; readonly config?: Json };
}

export async function loadTaskConfiguration(configPath: string) {
  const input: TaskConfigInput = JSON.parse(await readFile(configPath, "utf8"));
  const base = dirname(resolve(configPath));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Task configuration must be an object");
  const tickBudget = input.tickBudget ?? 36000;
  if (!Number.isSafeInteger(tickBudget) || tickBudget <= 0) throw new Error("tickBudget must be a positive integer");
  const sampleIntervalTicks = input.sampleIntervalTicks ?? 20;
  if (!Number.isSafeInteger(sampleIntervalTicks) || sampleIntervalTicks <= 0) throw new Error("sampleIntervalTicks must be positive");
  const pauseWhenIdle = input.pauseWhenIdle ?? true;
  if (typeof pauseWhenIdle !== "boolean") throw new Error("pauseWhenIdle must be a boolean");
  const expiryTicks = (value: number, name: string) => {
    if (!Number.isInteger(value) || (value !== -1 && (value < 1 || value > 2147483647))) throw new Error(`${name} must be -1 or an integer from 1 through 2147483647`);
    return value;
  };
  const groundedFieldOfViewDegrees = input.groundedFieldOfViewDegrees ?? 360;
  if (!Number.isInteger(groundedFieldOfViewDegrees) || groundedFieldOfViewDegrees < 1 || groundedFieldOfViewDegrees > 360) throw new Error("groundedFieldOfViewDegrees must be an integer from 1 through 360");
  const grounded = {
    groundedBlockExpiryTicks: expiryTicks(input.groundedBlockExpiryTicks ?? 400, "groundedBlockExpiryTicks"),
    groundedEntityExpiryTicks: expiryTicks(input.groundedEntityExpiryTicks ?? 400, "groundedEntityExpiryTicks"),
    groundedFieldOfViewDegrees,
  };
  const profile = input.profile ?? "grounded_evidence";
  if (profile !== "grounded_evidence" && profile !== "loaded_world_state") throw new Error("profile must be grounded_evidence or loaded_world_state");
  const deathPolicy = input.deathPolicy ?? "respawn";
  if (deathPolicy !== "respawn") throw new Error("deathPolicy must be respawn");
  if (typeof input.snapshotPath !== "string" || !input.snapshotPath.trim()) throw new Error("snapshotPath is required");
  const snapshotDirectory = resolve(base, input.snapshotPath);
  const manifest: SnapshotManifest = JSON.parse(await readFile(join(snapshotDirectory, "manifest.json"), "utf8"));
  const worldDirectory = join(snapshotDirectory, "world");
  const sha256 = await snapshotDigest(worldDirectory);
  if (!manifest.revision || !manifest.seed || manifest.spawn.dimension !== "minecraft:overworld" || ![manifest.spawn.x, manifest.spawn.y, manifest.spawn.z, manifest.spawn.yaw, manifest.spawn.pitch].every(Number.isFinite)) throw new Error("Invalid snapshot manifest");
  if (typeof input.serverTemplatePath !== "string" || !input.serverTemplatePath.trim()) throw new Error("serverTemplatePath is required");
  const command = input.serverCommand;
  if (!Array.isArray(command) || !command.length || !command.every(value => typeof value === "string" && value.length)) throw new Error("serverCommand must be a nonempty argv array");
  const camera = input.camera === undefined || input.camera === null ? undefined : (() => {
    const value = input.camera;
    if (typeof value.clientTemplatePath !== "string" || !value.clientTemplatePath.trim()) throw new Error("camera.clientTemplatePath is required");
    const viewDistance = value.viewDistance ?? 4;
    if (!Number.isSafeInteger(viewDistance) || viewDistance < 2) throw new Error("camera.viewDistance must be an integer of at least 2");
    const width = value.width ?? 854;
    const height = value.height ?? 480;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 320 || height < 240 || width > 3840 || height > 2160) {
      throw new Error("camera.width and camera.height must be integers from 320x240 through 3840x2160");
    }
    return { clientTemplate: resolve(base, value.clientTemplatePath), viewDistance, width, height };
  })();
  const harnessCommand: unknown = input.harness?.command;
  if (!Array.isArray(harnessCommand) || !harnessCommand.length || !harnessCommand.every(value => typeof value === "string" && value.length)) throw new Error("harness.command is required: a nonempty argv array that starts the Harness");
  const workingDirectory: unknown = input.harness?.workingDirectory;
  if (workingDirectory !== undefined && (typeof workingDirectory !== "string" || !workingDirectory.trim())) throw new Error("harness.workingDirectory must be a nonempty path");
  const harness = { command: harnessCommand as [string, ...string[]], cwd: workingDirectory === undefined ? base : resolve(base, workingDirectory), config: input.harness?.config ?? null };
  return {
    tickBudget, sampleIntervalTicks, pauseWhenIdle, deathPolicy, spawn: manifest.spawn, manifest, harness, camera,
    metadata: {
      profile, deathPolicy, ...grounded,
      seed: manifest.seed, worldRevision: manifest.revision, worldSha256: sha256,
      worldFeasibility: manifest.feasibility, observationSchemaVersion,
      harness: { command: harness.command, config: harness.config },
      pausePolicy: pauseWhenIdle ? "runtime-pause-when-idle" : "realtime",
      sampleIntervalTicks,
      camera: camera === undefined ? null : { viewDistance: camera.viewDistance, width: camera.width, height: camera.height },
    },
    serverWorkingDirectoryTemplate: resolve(base, input.serverTemplatePath),
    serverCommand: command as [string, ...string[]],
    world: { source: { kind: "copied_snapshot" as const, worldDirectory }, worldKnowledgeProfile: profile, ...grounded },
  } as const;
}
