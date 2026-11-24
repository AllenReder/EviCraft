import { runScenarioHarness as runHarness } from "./test-context.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { messageText } from "../../../dist/harness/model-surface-message.js";
import { RuntimeAdapter } from "../../../dist/harness/runtime-adapter.js";
import { borrowedRuntimeSession, staticGoalContext } from "../../../dist/harness/run-harness.js";
import {
  scriptedSmokeModel,
  scriptedScenarioEnd, scriptedToolDecision,
  smokeModelConfig,
} from "./test-context.mjs";

/** Runtime occurrence and hazard-orchestration scenarios with their exact fixtures. */
export function createOccurrenceAndHazardScenarios({ runtimeCommand, assertBodyNear }) {
async function runRealHarnessOccurrenceSmoke(runtime, client, url) {
  console.log("smoke: live unmatched damage Occurrence remains informational");
  const directory = await mkdtemp(join(tmpdir(), "mc-agent-real-harness-"));
  let requests = 0;
  const cycles = [];
  const model = scriptedSmokeModel(async (_request) => {
      requests += 1;
      if (requests === 2) {
        return scriptedScenarioEnd();
      }
      await runtimeCommand(runtime, "damage bot 1");
      return scriptedToolDecision("wait-after-damage", "wait", { seconds: 0 });
  });
  try {
    const result = await runHarness({
      config: {
        mode: "native",
        runtime: { url },
        bot: { username: "bot" },
        model: smokeModelConfig(),
        data: { directory },
        artifacts: { directory },
      },
      agentContext: staticGoalContext("Verify live unmatched damage Occurrence remains informational."),
      secrets: { modelApiKey: "smoke-script" },
      createRuntimeSession: async () => borrowedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
      onProgress(event) {
        if (event.type === "decision_context") cycles.push(event.cycle);
      },
    });
    if (result.status !== "ended" || result.endReason !== "external_stop"
        || requests !== 2 || new Set(cycles).size < 2) {
      throw new Error(`Harness Occurrence smoke did not retain informational damage: ${JSON.stringify({
        result, requests, turnCycles: cycles,
      })}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runRealHarnessLowAirSurfaceSmoke(runtime, client, url) {
  console.log("smoke: live low-air hazard decision surfaces through exact water-column steps");
  const directory = await mkdtemp(join(tmpdir(), "mc-agent-real-surface-"));
  const initial = await client.toolCall("get_self_status", {});
  const x = Math.floor(initial.data?.position?.x);
  const y = Math.floor(initial.data?.position?.y);
  const z = Math.floor(initial.data?.position?.z);
  if (![x, y, z].every(Number.isFinite)) {
    throw new Error(`low-air fixture lacked a current body position: ${JSON.stringify(initial)}`);
  }
  let requests = 0;
  let sawLowAirReasons = false;
  let selectedSurface = false;
  const cycles = [];
  const started = [];
  const finished = [];
  let passed = false;
  const model = scriptedSmokeModel(async (request) => {
      if (++requests > 6) throw new Error("low-air smoke exceeded its bounded decision count");
      const message = request.messages.findLast((candidate) =>
        candidate.role === "user" && messageText(candidate).includes("<minecraft_pre_step_context"));
      const matched = message === undefined ? null : messageText(message).match(
        /<minecraft_pre_step_context[^>]*>\n([\s\S]*)\n<\/minecraft_pre_step_context>/u);
      if (matched === null) throw new Error("low-air decision lacked fresh context");
      const context = JSON.parse(matched[1]);
      if (context.hazard_decision !== undefined || context.interrupted_actions !== undefined) {
        throw new Error(`low-air context carried the removed side channel: ${matched[1]}`);
      }
      // Hazard reasons reach the model via trigger.hazard_reasons when no Tool
      // result could absorb them, or on a committed INTERRUPTED Tool result.
      sawLowAirReasons ||= context.trigger?.hazard_reasons?.includes("low_air") === true
        || request.messages.some((candidate) => candidate.role === "tool"
          && messageText(candidate).includes("interrupted (low_air"));
      if (context.turn_observation.includes("underwater=true")) {
        if (!sawLowAirReasons) throw new Error("underwater response lacked low-air hazard reasons");
        selectedSurface = true;
        return scriptedToolDecision(`model-chooses-surface-${requests}`, "run_code", {
          description: "Respond to the observed low-air hazard by surfacing",
          code: "return await abilities.surface({});",
        });
      }
      if (!selectedSurface) throw new Error("body surfaced before the model selected a rescue");
      return scriptedScenarioEnd();
  });
  try {
    await runtimeCommand(runtime, "effect give bot minecraft:instant_health 1 10 true");
    await runtimeCommand(runtime, `fill ${x - 3} ${y - 1} ${z - 3} ${x + 3} ${y + 7} ${z + 3} air`);
    await runtimeCommand(runtime, `fill ${x - 1} ${y - 1} ${z - 1} ${x + 1} ${y - 1} ${z + 1} stone`);
    await runtimeCommand(runtime, `fill ${x - 1} ${y} ${z - 1} ${x + 1} ${y + 4} ${z + 1} water`);
    const movementProbe = [];
    for (const targetY of [y + 2, y + 4]) {
      movementProbe.push(await client.toolCall("goto", { goal: { kind: "cell", position: { x, y: targetY, z } } }));
    }
    const movementProbeStatus = await client.toolCall("get_self_status", {});
    if (movementProbe.some((result) => !result.success)
        || movementProbeStatus.data?.underwater === true) {
      throw new Error(`water-column exact-coordinate probe did not surface: ${JSON.stringify({
        movementProbe, movementProbeStatus,
      })}`);
    }
    // Explicitly return to the submerged start; do not rely on drifting down
    // after the movement probe, or on health retained from earlier smokes.
    await runtimeCommand(runtime, "effect give bot minecraft:instant_health 1 10 true");
    await runtimeCommand(runtime, `tp bot ${x + 0.5} ${y} ${z + 0.5}`);
    const fixtureDeadline = Date.now() + 20_000;
    let fixture;
    while (Date.now() < fixtureDeadline) {
      fixture = await client.toolCall("get_self_status", {});
      if (fixture.data?.underwater === true && Number.parseInt(fixture.data?.air, 10) <= 100) break;
      await delay(50);
    }
    if (fixture?.data?.underwater !== true || Number.parseInt(fixture.data?.air, 10) > 100) {
      throw new Error(`low-air water-column fixture was not established: ${JSON.stringify(fixture)}`);
    }
    // An unchanged body publishes air once every 20 ticks. Start the Harness right after such a
    // publication so the next one cannot arrive while the first decision is being assembled; that
    // arrival drops the hazard reasons with the discarded decision.
    let unsubscribe = () => {};
    const published = new Promise((resolve) => {
      unsubscribe = client.onOccurrence((occurrence) => {
        if (occurrence.type === "body_state_changed" && occurrence.data?.underwater === true
            && occurrence.data?.air <= 100) resolve(true);
      });
    });
    const synchronized = await Promise.race([published, delay(5_000).then(() => false)]);
    unsubscribe();
    if (!synchronized) throw new Error("low-air fixture published no low-air body state within 5 s");

    const result = await runHarness({
      hazardDecisions: "enabled",
      config: {
        mode: "code",
        runtime: { url },
        bot: { username: "bot" },
        model: smokeModelConfig(),
        data: { directory },
        artifacts: { directory },
      },
      agentContext: staticGoalContext("Verify a low-air hazard decision and choose surface."),
      secrets: { modelApiKey: "smoke-script" },
      createRuntimeSession: async () => borrowedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
      onProgress(event) {
        if (event.type === "decision_context") cycles.push(event.cycle);
        if (event.type === "ability_call_started") started.push(event);
        if (event.type === "ability_call_finished") finished.push(event);
      },
    });
    const surface = finished.findLast((event) => event.ability === "surface");
    const finalStatus = await client.toolCall("get_self_status", {});
    if (result.status !== "ended" || result.endReason !== "external_stop"
        || !sawLowAirReasons || !selectedSurface || new Set(cycles).size < 2
        || surface?.source !== "agent" || surface.result?.ok !== true
        || started.some((event) => event.source === "harness")
        || result.latestObservation.underwater || finalStatus.data?.underwater !== false) {
      throw new Error(`Harness low-air surface smoke did not reach a fresh breathable Turn: ${JSON.stringify({
        result, requests, turnCycles: cycles, sawLowAirReasons, surface, finalStatus, started,
      })}`);
    }
    passed = true;
  } finally {
    await runtimeCommand(runtime, `fill ${x - 3} ${y - 1} ${z - 3} ${x + 3} ${y + 7} ${z + 3} air`)
      .catch(() => {});
    // A failed run keeps its Harness journal for diagnosis.
    if (passed) await rm(directory, { recursive: true, force: true });
    else console.error(`low-air smoke retained Harness artifacts: ${directory}`);
  }
}

async function runOccurrenceContractSmoke(runtime, client, occurrences) {
  console.log("smoke: factual body-state occurrence contract");
  const waitFor = async (predicate, label, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const occurrence = occurrences.find(predicate);
      if (occurrence !== undefined) return occurrence;
      await delay(25);
    }
    throw new Error(`${label} did not arrive: ${JSON.stringify(occurrences.slice(-20))}`);
  };
  let fixture;
  try {
    const initial = await waitFor((value) => value.type === "body_state_changed", "initial body state");
    const expectedKeys = [
      "health", "max_health", "air", "max_air", "underwater", "in_lava", "on_fire",
      "suffocating", "intersecting_blocks",
    ];
    if (JSON.stringify(Object.keys(initial.data)) !== JSON.stringify(expectedKeys)
        || !Array.isArray(initial.data.intersecting_blocks)) {
      throw new Error(`initial body state was incomplete: ${JSON.stringify(initial)}`);
    }

    const silentFrom = occurrences.length;
    await delay(1_250);
    if (occurrences.slice(silentFrom).some((value) => value.type === "body_state_changed")) {
      throw new Error(`unchanged body state was not silent: ${JSON.stringify(occurrences.slice(silentFrom))}`);
    }

    const status = await client.toolCall("get_self_status", {});
    const position = status.data?.position;
    if (!status.success || !position || ![position.x, position.y, position.z].every(Number.isFinite)) {
      throw new Error(`suffocation fixture lacked a current body position: ${JSON.stringify(status)}`);
    }
    const fixtureFeet = { x: Math.floor(position.x), y: 200, z: Math.floor(position.z) };
    await runtimeCommand(runtime,
      `fill ${fixtureFeet.x - 2} ${fixtureFeet.y - 1} ${fixtureFeet.z - 2} ${fixtureFeet.x + 2} ${fixtureFeet.y + 3} ${fixtureFeet.z + 2} air`);
    await runtimeCommand(runtime,
      `fill ${fixtureFeet.x - 2} ${fixtureFeet.y - 1} ${fixtureFeet.z - 2} ${fixtureFeet.x + 2} ${fixtureFeet.y - 1} ${fixtureFeet.z + 2} stone`);
    // A newly provisioned ServerPlayer has vanilla spawn damage immunity. Let it expire
    // before the later damage assertion while the unchanged-state silence check continues.
    await delay(3_500);
    fixture = { x: fixtureFeet.x, y: fixtureFeet.y + 1, z: fixtureFeet.z };
    const suffocationFrom = occurrences.length;
    await runtimeCommand(runtime,
      `fill ${fixtureFeet.x} ${fixtureFeet.y} ${fixtureFeet.z} ${fixture.x} ${fixture.y} ${fixture.z} stone`);
    await runtimeCommand(runtime,
      `tp bot ${fixtureFeet.x + 0.5} ${fixtureFeet.y} ${fixtureFeet.z + 0.5}`);
    await assertBodyNear(client,
      { x: fixtureFeet.x + 0.5, y: fixtureFeet.y, z: fixtureFeet.z + 0.5 },
      "suffocation fixture start", 0.75);
    const embedded = await client.toolCall("get_self_status", {});
    if (embedded.data?.suffocating !== true) {
      throw new Error(`embedded body did not report suffocation: ${JSON.stringify({ fixture, embedded })}`);
    }
    const suffocating = await waitFor(
      (value, index) => index >= suffocationFrom && value.type === "body_state_changed"
        && value.data.suffocating === true,
      "immediate suffocating body change",
    );
    if (!suffocating.data.intersecting_blocks.some((block) =>
      block.x === fixture.x && block.y === fixture.y && block.z === fixture.z)) {
      throw new Error(`suffocating occurrence omitted the exact intersecting block: ${JSON.stringify(suffocating)}`);
    }
    const damage = await waitFor(
      (value, index) => index >= suffocationFrom && value.type === "damage_received",
      "instantaneous suffocation damage",
    );
    const suffocationEvidence = await client.toolCall("get_self_status", {});
    if (suffocationEvidence.data?.suffocating !== true
        || !suffocationEvidence.data?.intersecting_blocks?.some((block) =>
          block.x === fixture.x && block.y === fixture.y && block.z === fixture.z)) {
      throw new Error(`query evidence omitted current suffocation: ${JSON.stringify(suffocationEvidence)}`);
    }

    const clearFrom = occurrences.length;
    await runtimeCommand(runtime,
      `fill ${fixture.x} ${fixture.y - 1} ${fixture.z} ${fixture.x} ${fixture.y} ${fixture.z} air`);
    const cleared = await waitFor(
      (value, index) => index >= clearFrom && value.type === "body_state_changed"
        && value.data.suffocating === false,
      "immediate suffocation clear",
    );
    if (cleared.data.intersecting_blocks.length !== 0) {
      throw new Error(`cleared body state retained intersecting blocks: ${JSON.stringify(cleared)}`);
    }

    const healthChange = await waitFor(
      (value, index) => index >= clearFrom && value.type === "body_state_changed"
        && value.data.health > cleared.data.health,
      "twenty-tick health delivery",
    );
    const healthDelay = healthChange.server_tick - cleared.server_tick;
    if (damage.data.damage_type !== "minecraft:in_wall"
        || damage.sequence >= suffocating.sequence
        || cleared.sequence >= healthChange.sequence
        || healthDelay !== 20) {
      throw new Error(`damage/health occurrence contract was wrong: ${JSON.stringify({
        cleared, damage, healthChange, healthDelay,
      })}`);
    }

    const waterFrom = occurrences.length;
    await runtimeCommand(runtime,
      `fill ${fixture.x - 1} ${fixture.y - 1} ${fixture.z - 1} ${fixture.x + 1} ${fixture.y + 1} ${fixture.z + 1} water`);
    const underwater = await waitFor(
      (value, index) => index >= waterFrom && value.type === "body_state_changed"
        && value.data.underwater === true,
      "immediate underwater body change",
    );
    const airChange = await waitFor(
      (value) => value.type === "body_state_changed" && value.sequence > underwater.sequence
        && value.data.underwater === true && value.data.air < underwater.data.air,
      "twenty-tick air delivery",
    );
    if (airChange.server_tick - underwater.server_tick !== 20) {
      throw new Error(`air change was not delivered on the twentieth tick: ${JSON.stringify({
        underwater, airChange,
      })}`);
    }
    const breathableFrom = occurrences.length;
    await runtimeCommand(runtime,
      `fill ${fixture.x - 1} ${fixture.y - 1} ${fixture.z - 1} ${fixture.x + 1} ${fixture.y + 1} ${fixture.z + 1} air`);
    await waitFor(
      (value, index) => index >= breathableFrom && value.type === "body_state_changed"
        && value.data.underwater === false,
      "immediate underwater clear",
    );

    const burstFrom = occurrences.length;
    await runtimeCommand(runtime, "mcagent_smoke_damage_burst");
    const burstDeadline = Date.now() + 5_000;
    while (Date.now() < burstDeadline
        && occurrences.slice(burstFrom).filter((value) => value.type === "damage_received").length < 2) {
      await delay(25);
    }
    const burst = occurrences.slice(burstFrom).filter((value) => value.type === "damage_received");
    if (burst.length !== 2
        || burst[0].server_tick !== burst[1].server_tick
        || burst[0].sequence + 1 !== burst[1].sequence
        || burst[0].data.amount !== 1 || burst[1].data.amount !== 1
        || burst[0].data.health !== 19 || burst[1].data.health !== 19
        || burst[0].data.damage_type !== "minecraft:out_of_world"
        || burst[1].data.damage_type !== "minecraft:generic_kill") {
      throw new Error(`same-tick healed damage callbacks were not factual and ordered: ${JSON.stringify(burst)}`);
    }
  } finally {
    if (fixture !== undefined) {
      await runtimeCommand(runtime,
        `fill ${fixture.x - 2} ${fixture.y - 2} ${fixture.z - 2} ${fixture.x + 2} ${fixture.y + 2} ${fixture.z + 2} air`).catch(() => {});
    }
  }
}

async function captureRawOccurrenceWindow(runtime, url, token) {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const frames = [];
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.on("message", (wire) => frames.push(wire.toString()));
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "actor.get", params: {} }));
  const gameTime = async () => {
    const response = await runtimeCommand(runtime, "time query gametime");
    const match = /(\d+)\D*$/u.exec(response);
    if (match === null) throw new Error(`could not read server game time: ${response}`);
    return Number(match[1]);
  };
  const startedAt = await gameTime();
  let endedAt = startedAt;
  const deadline = Date.now() + 5_000;
  while (endedAt - startedAt < 25 && Date.now() < deadline) {
    await delay(100);
    endedAt = await gameTime();
  }
  socket.close();
  await new Promise((resolve) => socket.once("close", resolve));
  if (endedAt - startedAt < 25) {
    throw new Error(`raw unchanged window covered only ${endedAt - startedAt} server ticks`);
  }
  return { frames: frames.map((wire) => JSON.parse(wire)), serverTicks: endedAt - startedAt };
}

  return {
    runRealHarnessOccurrenceSmoke,
    runRealHarnessLowAirSurfaceSmoke,
    runOccurrenceContractSmoke,
    captureRawOccurrenceWindow,
  };
}
