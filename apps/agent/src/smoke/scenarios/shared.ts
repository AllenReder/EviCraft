import { appendFile, mkdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import type { BlockPosition, RuntimeClient } from "@evicraft/runtime-sdk";

import { canonicalBlockId } from "../../harness/canonical-registry-id.js";
import { messageText } from "../../harness/model-surface-message.js";
import { RuntimeAdapter } from "../../harness/runtime-adapter.js";
import { borrowedRuntimeSession, staticGoalContext, type HarnessProgressEvent } from "../../harness/run-harness.js";
import type { AbilityConformanceManifest } from "../conformance-world.js";
import type { ScriptedModelCall } from "../../harness/testing/scripted-language-model.js";
import { sendServerCommand } from "../neoforge-server-process.js";
import { ensureScenarioBot } from "../scenario-harness.js";

export { staticGoalContext };
export {
  ensureScenarioBot, runScenarioHarness, scriptedScenarioEnd, scriptedToolDecision,
} from "../scenario-harness.js";

export function borrowedScenarioRuntimeSession(client: RuntimeClient) {
  return borrowedRuntimeSession(new RuntimeAdapter(client));
}

export interface ScenarioRunContext {
  readonly client: RuntimeClient;
  readonly runtimeUrl: string;
  readonly bearerToken: string;
  readonly artifactsDirectory: string;
  readonly manifest: AbilityConformanceManifest;
  readonly server: ChildProcess;
  readonly oracle: ScenarioOracle;
}

/** Privileged test-owned command access, separate from every Agent-visible Runtime service. */
export interface ScenarioOracle {
  executeMinecraftCommand(command: string): Promise<string>;
}

export async function assertScenarioOracle(
  context: Pick<ScenarioRunContext, "oracle" | "artifactsDirectory">,
  label: string,
  predicate: string,
): Promise<void> {
  // Vanilla execute's terminal condition reports success directly to the RCON
  // source. `run say` broadcasts chat instead and may return an empty response.
  const command = predicate;
  const response = await context.oracle.executeMinecraftCommand(command);
  const passed = /^Test passed(?:, count: [1-9]\d*)?$/u.test(response.trim());
  await appendFile(`${context.artifactsDirectory}/oracle-receipts.jsonl`, `${JSON.stringify({
    label, predicate, command, response, verdict: passed ? "pass" : "fail",
  })}\n`);
  if (!passed) throw new Error(`Scenario Oracle predicate failed: ${label}: ${response}`);
}

/** Bot-free proof that the Oracle command executes without advancing game time. */
export async function assertPausedScenarioOracle(
  context: Pick<ScenarioRunContext, "oracle" | "artifactsDirectory"> & Readonly<{
    client: {
      runtimeInfo(): Promise<Readonly<{ simulation_suspended: boolean }>>;
    };
  }>,
  label: string,
  predicate: string,
) {
  // An idle World Run pauses before its next tick; give that decision a moment to be taken.
  for (let attempt = 0; attempt < 40 && !(await context.client.runtimeInfo()).simulation_suspended; attempt++) await delay(50);
  const snapshot = async () => {
    const info = await context.client.runtimeInfo();
    const response = await context.oracle.executeMinecraftCommand("time query gametime");
    const match = /(\d+)\D*$/u.exec(response);
    if (match === null) throw new Error(`Scenario Oracle could not read game time: ${response}`);
    return { simulation_suspended: info.simulation_suspended, game_time: Number(match[1]) };
  };
  const before = await snapshot();
  if (!before.simulation_suspended) throw new Error("Scenario Oracle started without paused simulation");
  await assertScenarioOracle(context, label, predicate);
  const after = await snapshot();
  const receipt = { before, after };
  await appendFile(`${context.artifactsDirectory}/oracle-pause-receipts.jsonl`, `${JSON.stringify({ label, ...receipt })}\n`);
  if (!after.simulation_suspended || before.game_time !== after.game_time) {
    throw new Error(`Scenario Oracle advanced game time or resumed simulation: ${JSON.stringify(receipt)}`);
  }
  return receipt;
}

export async function ensureArtifacts(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export async function intervene(
  context: Pick<ScenarioRunContext, "server" | "artifactsDirectory" | "client"> | ChildProcess,
  labelOrArtifacts: string,
  commandOrLabel: string,
  legacyCommand?: string,
): Promise<void> {
  if (legacyCommand !== undefined) {
    await appendFile(`${labelOrArtifacts}/smoke-interventions.jsonl`,
      `${JSON.stringify({ label: commandOrLabel, command: legacyCommand })}\n`);
    await sendServerCommand(context as ChildProcess, legacyCommand);
    return;
  }
  const label = labelOrArtifacts;
  const command = commandOrLabel;
  const { server, artifactsDirectory, client } = context as Pick<ScenarioRunContext, "server" | "artifactsDirectory" | "client">;
  await appendFile(`${artifactsDirectory}/smoke-interventions.jsonl`,
    `${JSON.stringify({ label, command })}\n`);
  const marker = `mcagent_intervention_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await sendServerCommand(server, command);
  // stdin completion acknowledges bytes, not execution. This FIFO console receipt
  // prevents a dependent tool call from racing the test-owned world intervention.
  await sendServerCommand(server, `say ${marker}`);
  // Console commands run inside a tick, and an idle World Run does not tick by itself.
  const deadline = Date.now() + 15_000;
  while (!await logContains(`${artifactsDirectory}/server.log`, marker)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for intervention ${label}`);
    await client.toolCall("wait", { ticks: 1 });
  }
}

async function logContains(path: string, text: string): Promise<boolean> {
  try { return (await readFile(path, "utf8")).includes(text); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function waitForLogText(path: string, text: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      if ((await readFile(path, "utf8")).includes(text)) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for Scenario Oracle receipt: ${text}`);
}

export function smokeHarnessConfig(runtimeUrl: string, directory: string) {
  return {
    mode: "code" as const,
    // This matrix verifies every registered Ability, including optional search composites.
    abilitySet: "shared" as const,
    runtime: { url: runtimeUrl },
    bot: { username: "bot" },
    model: {
      provider: "openai",
      model: "smoke-script",
      limits: { contextWindowTokens: 200_000, maxOutputTokens: 512 },
    },
    data: { directory },
    artifacts: { directory },
  };
}

export function freshPreStepContext(request: ScriptedModelCall): Record<string, unknown> {
  const message = request.messages.findLast((candidate) =>
    candidate.role === "user" && messageText(candidate).includes("<minecraft_pre_step_context"));
  const match = messageText(message!).match(
    /<minecraft_pre_step_context[^>]*>\n([\s\S]*)\n<\/minecraft_pre_step_context>/u,
  );
  if (match?.[1] === undefined) throw new Error("Scenario omitted pre-step context");
  return record(JSON.parse(match[1]));
}

/**
 * Entities saved in a fixture world join the level on its first tick, and an idle World Run does
 * not tick by itself. Let game time pass one tick at a time until every fixture entity is perceived.
 */
export async function settleFixtureEntities(
  client: RuntimeClient,
  entityId: string,
  positions: readonly BlockPosition[],
  maxTicks = 20,
): Promise<void> {
  await ensureScenarioBot(client);
  for (let ticks = 0; ; ticks++) {
    const { tracks } = await client.entityList({ entityIdGlob: entityId });
    if (positions.every((position) => tracks.some((track) => track.entity_id === entityId
        && Math.floor(track.position.x) === position.x
        && Math.floor(track.position.y) === position.y
        && Math.floor(track.position.z) === position.z))) return;
    if (ticks >= maxTicks) {
      throw new Error(`fixture ${entityId} entities were not perceived within ${maxTicks} ticks: ${JSON.stringify(tracks)}`);
    }
    await client.toolCall("wait", { ticks: 1 });
  }
}

export function assertInitialObservation(
  request: ScriptedModelCall,
  manifest: AbilityConformanceManifest,
): void {
  const context = freshPreStepContext(request);
  const observation = stringField(context, "turn_observation");
  const feet = observation.match(/^feet=(-?\d+),(-?\d+),(-?\d+)$/mu);
  if (feet === null || Number(feet[1]) !== manifest.sharedSpawn.x
      || Number(feet[2]) !== manifest.sharedSpawn.y
      || Number(feet[3]) !== manifest.sharedSpawn.z) {
    throw new Error(`${manifest.scenario} did not start at its sealed shared spawn`);
  }
  for (const fixture of Object.values(manifest.fixtures)) {
    if (fixture.initiallyVisible === false) continue;
    const positions = observedPositions(request, fixture.blockId);
    if (!positions.some((position) => samePosition(position, fixture.position))) {
      throw new Error(`${manifest.scenario} initial observation omitted ${fixture.blockId}`);
    }
  }
}

export function observedPositions(
  request: ScriptedModelCall,
  blockId: string,
): readonly BlockPosition[] {
  return observedBlockPositions(stringField(freshPreStepContext(request), "turn_observation"), blockId);
}

export function observedBlockPositions(
  observation: string,
  blockId: string,
): readonly BlockPosition[] {
  const groups = [...observation.matchAll(/^(\S+) count=\d+ positions=([^\n]+)$/gmu)]
    .filter((match) => match[1] !== undefined && canonicalBlockId(match[1]) === blockId);
  return groups.flatMap((match) => match[2]!.split(";")).map((value) => {
    const coordinates = value.split(",").map((coordinate) => Number(coordinate));
    if (coordinates.length !== 3 || !coordinates.every(Number.isInteger)) {
      throw new Error(`invalid observed block position: ${value}`);
    }
    return { x: coordinates[0]!, y: coordinates[1]!, z: coordinates[2]! };
  });
}

export function lastAbilityResult(
  events: readonly Extract<HarnessProgressEvent, { type: "ability_call_finished" }>[],
  ability: string,
  predicate: (result: any) => boolean = () => true,
): any {
  return events.findLast((event) => event.ability === ability && predicate(event.result))?.result;
}

export async function runtimeInventoryCount(client: RuntimeClient, itemId: string): Promise<number> {
  const inspected = await client.toolCall("inspect_gui", {});
  if (!inspected.success || !Array.isArray(inspected.data?.slots)) {
    throw new Error(`could not inspect Runtime inventory: ${JSON.stringify(inspected)}`);
  }
  return inspected.data.slots
    .filter((slot: any) => slot.owner === "player" && slot.item_id === itemId)
    .reduce((total: number, slot: any) => total + slot.count, 0);
}

export function record(value: unknown): Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

export function stringField(value: unknown, field: string): string {
  const selected = record(value)[field];
  if (typeof selected !== "string") throw new Error(`${field} must be a string`);
  return selected;
}

export function hasField(value: unknown, field: string): boolean {
  return Object.hasOwn(record(value), field);
}

export function samePosition(left: BlockPosition, right: BlockPosition): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}
