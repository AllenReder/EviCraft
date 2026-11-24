#!/usr/bin/env node

import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeClient } from "../../../../../runtime/sdk/typescript/dist/index.js";
import { RuntimeAdapter } from "../../../dist/harness/runtime-adapter.js";
import { AbilityRuntime } from "../../../dist/harness/ability-runtime.js";
import { abilities } from "../../../dist/harness/abilities/index.js";
import { assertNotListening } from "../../../dist/smoke/neoforge-server-process.js";
import { runWithNeoForgeSmokeRun } from "../../../dist/smoke/neoforge-smoke-run.js";
import { selectRuntimeSdkSmokeScenario } from "../../../dist/smoke/runtime-sdk-smoke.js";
import { runDefaultRuntimeSdkSmoke } from "./default-scenarios.mjs";
import { runSimulationSuspensionSmoke as runSimulationSuspensionScenario } from "./simulation-suspension.mjs";
import { runMineDownSmoke as runMineDownScenario } from "./mine-down.mjs";
import { runWorldKnowledgeProfileSmoke as runWorldKnowledgeProfileScenario } from "./world-knowledge-profile.mjs";
import { createOcclusionAndReselectionScenarios } from "./occlusion-and-reselection.mjs";
import { createOccurrenceAndHazardScenarios } from "./occurrence-and-hazards.mjs";
import { createHarnessWorkflowScenarios } from "./harness-workflows.mjs";
import { runObsidianPortalSmoke } from "./obsidian-portal.mjs";
import { runtimeCommand, waitForLog } from "./test-context.mjs";
import {
  runAuthorityProvisionedSmoke,
  runAuthorityStartupSmoke,
} from "./benchmark-authority.mjs";

const {
  runExactBreakOcclusionSmoke,
  runGotoAndBreakOccludingSmoke,
  runCollectBlocksSmoke,
  runOcclusionAndReselectionSmoke,
} = createOcclusionAndReselectionScenarios({
  runtimeCommand,
  assertBodyNear,
  matchingItemCount,
});



async function matchingItemCount(runtime, player, itemId) {
  const response = await runtimeCommand(runtime, `clear ${player} ${itemId} 0`);
  const count = response.match(/\d+/)?.[0];
  return count === undefined ? 0 : Number.parseInt(count, 10);
}

const {
  runRealHarnessNativeSurfaceSmoke,
  runRealHarnessExplorationSmoke,
  runSmeltAtFurnaceSmoke,
} = createHarnessWorkflowScenarios({
  runtimeCommand,
  matchingItemCount,
  assertBodyNear,
});

const {
  runRealHarnessOccurrenceSmoke,
  runRealHarnessLowAirSurfaceSmoke,
  runOccurrenceContractSmoke,
  captureRawOccurrenceWindow,
} = createOccurrenceAndHazardScenarios({
  runtimeCommand,
  assertBodyNear,
});



async function assertBodyNear(client, expected, label, maximumDistance = 1.0) {
  const status = await client.toolCall("get_self_status", {});
  const position = status.data?.position;
  const distance = position && Math.hypot(
    position.x - expected.x, position.y - expected.y, position.z - expected.z);
  if (!status.success || !Number.isFinite(distance) || distance > maximumDistance) {
    throw new Error(`${label} did not place the Runtime body near the expected position: ${JSON.stringify({ expected, status })}`);
  }
}

async function runMineDownSmoke(runtime, client, fixtureX, fixtureY, fixtureZ) {
  await runMineDownScenario({
    runtime,
    client,
    fixtureX,
    fixtureY,
    fixtureZ,
    command: async (command) => await runtimeCommand(runtime, command),
    assertBodyNear,
    AbilityRuntime,
    RuntimeAdapter,
    abilities,
    delay,
  });
}


async function runTunnelForBlocksSmoke(runtime, client, fixtureX, fixtureY, fixtureZ) {
  console.log("smoke: live tunnel_for_blocks uses embodied feet and Tunnel Frontier evidence");
  const abilityRuntime = new AbilityRuntime();
  for (const definition of abilities) await abilityRuntime.register(definition);
  const context = {
    runtime: new RuntimeAdapter(client),
    services: {
      async wait(seconds, signal) {
        await delay(seconds * 1_000, undefined, { signal });
      },
    },
  };
  const tunnel = { x: fixtureX - 8, y: fixtureY, z: fixtureZ + 8 };
  const destination = { x: tunnel.x + 1, y: tunnel.y, z: tunnel.z };
  const target = { x: tunnel.x + 2, y: tunnel.y, z: tunnel.z };
  await runtimeCommand(runtime,
    `fill ${tunnel.x - 2} ${tunnel.y - 2} ${tunnel.z - 2} ${tunnel.x + 4} ${tunnel.y + 3} ${tunnel.z + 2} stone`);
  await runtimeCommand(runtime,
    `fill ${tunnel.x - 1} ${tunnel.y} ${tunnel.z - 1} ${tunnel.x + 3} ${tunnel.y + 2} ${tunnel.z + 1} air`);
  await runtimeCommand(runtime,
    `fill ${destination.x} ${destination.y} ${destination.z} ${destination.x} ${destination.y + 1} ${destination.z} stone`);
  await runtimeCommand(runtime,
    `setblock ${target.x} ${target.y} ${target.z} minecraft:netherite_block`);
  const dryStart = await runtimeCommand(runtime,
    `execute if block ${tunnel.x} ${tunnel.y} ${tunnel.z} air if block ${tunnel.x} ${tunnel.y + 1} ${tunnel.z} air`);
  if (!dryStart.includes("Test passed")) {
    throw new Error(`tunnel_for_blocks dry fixture was not established: ${JSON.stringify({
      tunnel, dryStart,
    })}`);
  }
  await runtimeCommand(runtime,
    `tp bot ${tunnel.x + 0.5} ${tunnel.y} ${tunnel.z + 0.5} -90 0`);
  await runtimeCommand(runtime,
    "item replace entity bot weapon.mainhand with minecraft:diamond_pickaxe 1");
  await client.observe();
  const result = await abilityRuntime.dispatch("tunnel_for_blocks", {
    block_id_glob: "minecraft:netherite_block",
    direction: "east",
    max_length: 1,
  }, context);
  const clearanceAir = [];
  for (const y of [destination.y + 1, destination.y]) {
    clearanceAir.push(await runtimeCommand(runtime,
      `execute if block ${destination.x} ${y} ${destination.z} air`));
  }
  const targetStillPresent = await runtimeCommand(runtime,
    `execute if block ${target.x} ${target.y} ${target.z} minecraft:netherite_block`);
  await assertBodyNear(client, {
    x: destination.x + 0.5,
    y: destination.y,
    z: destination.z + 0.5,
  }, "east tunnel_for_blocks", 0.75);
  if (!result.ok || result.data?.completed_length !== 1
      || result.data?.broken?.length !== 2
      || result.data?.target?.position?.x !== target.x
      || result.data?.target?.position?.y !== target.y
      || result.data?.target?.position?.z !== target.z
      || clearanceAir.some((entry) => !entry.includes("Test passed"))
      || !targetStillPresent.includes("Test passed")) {
    throw new Error(`tunnel_for_blocks did not clear and discover one bounded step: ${JSON.stringify({
      result, clearanceAir, targetStillPresent, target,
    })}`);
  }
  await runtimeCommand(runtime, "clear bot");
}

async function waitForBodyOnGround(client, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = await client.toolCall("get_self_status", {});
    if (status.success && status.data?.on_ground === true) return status;
    await delay(50);
  }
  throw new Error(`${label} did not settle on ground: ${JSON.stringify(status)}`);
}

async function waitForBodyHorizontallyStill(client, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = await client.toolCall("get_self_status", {});
    const velocity = status.data?.velocity;
    if (status.success && status.data?.on_ground === true && velocity
        && Math.abs(velocity.x) <= 0.0001 && Math.abs(velocity.z) <= 0.0001) {
      return status;
    }
    await delay(50);
  }
  throw new Error(`${label} did not stop horizontal movement: ${JSON.stringify(status)}`);
}

async function activateBlockAfterSettling(client, position, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let result;
  while (Date.now() < deadline) {
    await waitForBodyOnGround(client, label, Math.max(1, deadline - Date.now()));
    result = await client.toolCall("activate_block", { position });
    if (result.success || result.failure_type !== "out_of_reach") return result;
    await delay(50);
  }
  return result;
}

async function waitForExactBlock(client, dimension, position, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let result;
  while (Date.now() < deadline) {
    await client.observe();
    result = await client.blockGet(dimension, [position]);
    if (predicate(result.cells[0])) return result.cells[0];
    await delay(50);
  }
  throw new Error(`${label} did not reach the required exact Block Knowledge state: ${JSON.stringify(result)}`);
}

async function runSimulationSuspensionSmoke(runtime, client) {
  return await runSimulationSuspensionScenario({
    command: async (command) => await runtimeCommand(runtime, command),
    client,
  });
}

const scope = process.env.EVICRAFT_SMOKE_SCOPE;
const scenario = selectRuntimeSdkSmokeScenario(scope);
let simulationSuspensionReceipt;

await runWithNeoForgeSmokeRun({ execute: async (smokeRun) => {
  let runtime;
  if (scope === undefined) {
    console.log("smoke: missing-token startup");
    const disabledSdkPort = smokeRun.missingToken.runtimePort;
    const disabledAuthorityPort = smokeRun.missingToken.authorityPort;
    runtime = await smokeRun.startServer(smokeRun.missingToken);
    await waitForLog(runtime, "SDK disabled: EVICRAFT_RUNTIME_BEARER_TOKEN is missing");
    await waitForLog(runtime, "Benchmark Authority disabled: EVICRAFT_BENCHMARK_AUTHORITY_BEARER_TOKEN is missing");
    // These are live startup oracles; final stop/release checks stay in the run module.
    await assertNotListening(disabledSdkPort);
    await assertNotListening(disabledAuthorityPort);
    await smokeRun.stopServer(runtime);
    runtime = undefined;

    console.log("smoke: Authority-only disabled startup");
    runtime = await smokeRun.startServer(smokeRun.missingToken, {
      bearerToken: `runtime-without-authority-${process.pid}`,
    });
    const authorityDisabledRuntimeUrl = `ws://127.0.0.1:${disabledSdkPort}/rpc`;
    await waitForLog(runtime, `SDK listening at ${authorityDisabledRuntimeUrl}`);
    await waitForLog(runtime, "Benchmark Authority disabled: EVICRAFT_BENCHMARK_AUTHORITY_BEARER_TOKEN is missing");
    const authorityDisabledClient = await RuntimeClient.connect({
      url: authorityDisabledRuntimeUrl,
      bearerToken: `runtime-without-authority-${process.pid}`,
    });
    await authorityDisabledClient.runtimeInfo();
    await authorityDisabledClient.close();
    await assertNotListening(disabledAuthorityPort);
    await smokeRun.stopServer(runtime);
    runtime = undefined;

    console.log("smoke: invalid World Knowledge Profile startup");
    runtime = await smokeRun.startServer(smokeRun.missingToken, {
      bearerToken: `invalid-profile-${process.pid}`,
      worldKnowledgeProfile: "loaded",
    });
    await waitForLog(runtime,
      "EVICRAFT_WORLD_KNOWLEDGE_PROFILE must be grounded_evidence or loaded_world_state");
    await assertNotListening(disabledSdkPort);
    await smokeRun.stopServer(runtime);
    runtime = undefined;
  }

  console.log("smoke: authenticated startup");
  const {
    runtimePort: sdkPort,
    authorityPort,
    minecraftPort,
    rconPort,
    rconPassword,
  } = smokeRun.authenticated;
  const token = `runtime-sdk-${process.pid}`;
  const authorityToken = `benchmark-authority-${process.pid}`;
  const url = `ws://127.0.0.1:${sdkPort}/rpc`;
  const authorityUrl = `ws://127.0.0.1:${authorityPort}/rpc`;
  console.log(`smoke: authenticated ports sdk=${sdkPort} authority=${authorityPort} minecraft=${minecraftPort} rcon=${rconPort}`);
  runtime = await smokeRun.startServer(smokeRun.authenticated, {
    bearerToken: token,
    authorityBearerToken: authorityToken,
    pauseWhenIdle: scenario === "simulation-suspension",
  });
  await waitForLog(runtime, `SDK listening at ${url}`);
  await waitForLog(runtime, `Benchmark Authority listening at ${authorityUrl}`);

  let client;
  try {
    client = await RuntimeClient.connect({ url, bearerToken: token });
  } catch (error) {
    console.error(runtime.output().slice(-8000));
    throw error;
  }
  if (scenario === "simulation-suspension") {
    simulationSuspensionReceipt = await runSimulationSuspensionSmoke(runtime, client);
    client.close();
    return;
  }

  console.log("smoke: correct token connected");
  const occurrences = [];
  let stopOccurrences = client.onOccurrence((occurrence) => occurrences.push(occurrence));
  const info = await client.runtimeInfo();
  const expectedWorldKnowledgeProfile = process.env.EVICRAFT_WORLD_KNOWLEDGE_PROFILE
    ?? "grounded_evidence";
  if (info.protocol_version !== 4 || !["starting", "ready"].includes(info.readiness)
      || info.world_knowledge_profile !== expectedWorldKnowledgeProfile) {
    throw new Error(`unexpected runtime.info: ${JSON.stringify(info)}`);
  }
  await runAuthorityStartupSmoke({
    authorityUrl,
    authorityToken,
    runtimeToken: token,
    runtimeUrl: url,
  });
  let actor = await client.actorGet();
  if (actor !== null) {
    throw new Error(`server startup unexpectedly pre-created a Runtime Bot: ${JSON.stringify(actor)}`);
  }
  actor = await client.ensureBot("bot");
  if (actor.name !== "bot" || actor.lifecycle_state !== "alive" || actor.observation_revision < 0) {
    throw new Error(`unexpected actor after ensureBot: ${JSON.stringify(actor)}`);
  }
  const attached = await client.ensureBot("BOT");
  if (attached.uuid !== actor.uuid || attached.name !== "bot") {
    throw new Error(`same-name ensureBot did not attach: ${JSON.stringify({ actor, attached })}`);
  }
  await runAuthorityProvisionedSmoke({
    authorityUrl,
    authorityToken,
    actor,
    command: async (command) => await runtimeCommand(smokeRun.authenticated, command),
  });
  try {
    await client.ensureBot("other_bot");
    throw new Error("different-name ensureBot unexpectedly replaced the singleton Bot");
  } catch (error) {
    if (!String(error).match(/already exists.*bot/i)) throw error;
  }
  const occurrenceDeadline = Date.now() + 5_000;
  while (Date.now() < occurrenceDeadline
      && (!occurrences.some((value) => value.type === "actor_lifecycle_changed")
        || !occurrences.some((value) => value.type === "body_state_changed"))) {
    await delay(50);
  }
  const lifecycleOccurrence = occurrences.find((value) => value.type === "actor_lifecycle_changed");
  const bodyOccurrence = occurrences.find((value) => value.type === "body_state_changed");
  if (lifecycleOccurrence?.data?.lifecycle_state !== "alive"
      || typeof bodyOccurrence?.data?.air !== "number"
      || typeof bodyOccurrence?.data?.suffocating !== "boolean"
      || !Array.isArray(bodyOccurrence?.data?.intersecting_blocks)
      || "low_air" in (bodyOccurrence?.data ?? {})
      || "breath_state_changed" in (bodyOccurrence?.data ?? {})) {
    throw new Error(`Runtime Occurrence stream was not factual/live: ${JSON.stringify(occurrences)}`);
  }
  const readyInfo = await client.runtimeInfo();
  if (readyInfo.readiness !== "ready"
      || readyInfo.world_knowledge_profile !== expectedWorldKnowledgeProfile) {
    throw new Error(`runtime.info did not reach ready: ${JSON.stringify(readyInfo)}`);
  }

  if (scenario === "world-knowledge-profile") {
    stopOccurrences();
    client = await runWorldKnowledgeProfileScenario({
      client,
      url,
      token,
      actor,
      profile: expectedWorldKnowledgeProfile,
      command: async (command) => await runtimeCommand(runtime, command),
      assertBodyNear,
      waitForBodyOnGround,
      waitForExactBlock,
    });
    client.close();
    return;
  } else if (scenario === "mine-down") {
    const scopedStatus = await client.toolCall("get_self_status", {});
    const position = scopedStatus.data?.position;
    if (!scopedStatus.success || !position || ![position.x, position.z].every(Number.isFinite)) {
      throw new Error(`mine_down scope lacked the current body position: ${JSON.stringify(scopedStatus)}`);
    }
    await runMineDownSmoke(
      runtime, client, Math.floor(position.x), 200, Math.floor(position.z),
    );
    client.close();
    console.log(JSON.stringify({
      status: "passed",
      scope,
      checks: [
        "cardinal three-cell Staircase Descent Step",
        "exact frozen Feet Cell settlement with a physical backstop",
        "single-cell Vertical Descent Step",
      ],
    }, null, 2));
  } else if (scenario === "occurrence-and-hazards") {
    client.close();
    const rawWindow = await captureRawOccurrenceWindow(runtime, url, token);
    const rawOccurrences = rawWindow.frames.filter((frame) => frame.method === "runtime.occurrence");
    if (rawOccurrences.length !== 0) {
      throw new Error(`raw Runtime wire emitted an unchanged heartbeat or retired alias: ${JSON.stringify(rawOccurrences)}`);
    }
    client = await RuntimeClient.connect({ url, bearerToken: token });
    await client.runtimeInfo();
    stopOccurrences = client.onOccurrence((occurrence) => occurrences.push(occurrence));
    await runOccurrenceContractSmoke(runtime, client, occurrences);
    stopOccurrences();
    await runRealHarnessLowAirSurfaceSmoke(runtime, client, url);
    console.log(JSON.stringify({
      status: "passed",
      scope,
      endpoint: url,
      protocolVersion: info.protocol_version,
      actorUuid: actor.uuid,
      checks: [
        "complete body_state_changed shape",
        "raw wire silence for more than twenty server ticks with no retired alias",
        "unchanged body silence",
        "same-tick suffocation edges and exact intersecting blocks",
        "current query suffocation evidence",
        "damage_type and ordered twenty-tick health/air delivery",
        "same-tick per-callback damage despite intervening healing",
        "push-driven Low-Air Surface Harness settlement",
      ],
    }, null, 2));
  } else if (scenario === "occlusion-and-reselection") {
    const scopedStatus = await client.toolCall("get_self_status", {});
    if (!scopedStatus.success || typeof scopedStatus.data?.dimension !== "string") {
      throw new Error(`occlusion_and_reselection scope lacked the current dimension: ${JSON.stringify(scopedStatus)}`);
    }
    await runOcclusionAndReselectionSmoke(runtime, client, url, scopedStatus.data.dimension);
    client.close();
    console.log(JSON.stringify({
      status: "passed",
      scope,
      endpoint: url,
      protocolVersion: info.protocol_version,
      actorUuid: actor.uuid,
      checks: [
        "structured foliage Occluding Block and exact committed clearing",
        "target and blocker UUID drop collection plus Inventory reconciliation",
        "out-of-reach break complete generic interaction-pose search",
        "ID-mode current-feet reselection and failed-target exclusion",
        "compact non-destructive activation without break dispatch",
        "compact Composite result with complete nested Harness Run Event Log history",
      ],
    }, null, 2));
  } else if (scenario === "occluding-break") {
    const scopedStatus = await client.toolCall("get_self_status", {});
    if (!scopedStatus.success || typeof scopedStatus.data?.dimension !== "string") {
      throw new Error(`occluding_break scope lacked the current dimension: ${JSON.stringify(scopedStatus)}`);
    }
    await runGotoAndBreakOccludingSmoke(runtime, client, scopedStatus.data.dimension);
    client.close();
    console.log(JSON.stringify({
      status: "passed",
      scope,
      endpoint: url,
      protocolVersion: info.protocol_version,
      actorUuid: actor.uuid,
      checks: [
        "Agent-facing frozen target", "structured foliage Occluding Block exact clear",
        "compact target and clearing receipts", "target disappearance", "no pose search",
      ],
    }, null, 2));
  } else if (scenario === "obsidian-portal") {
    const scopedStatus = await client.toolCall("get_self_status", {});
    if (!scopedStatus.success || typeof scopedStatus.data?.dimension !== "string") {
      throw new Error(`obsidian scope lacked the current dimension: ${JSON.stringify(scopedStatus)}`);
    }
    await runObsidianPortalSmoke({
      runtime, client, url, dimension: scopedStatus.data.dimension, runtimeCommand, matchingItemCount,
    });
    client.close();
    console.log(JSON.stringify({
      status: "passed",
      scope,
      endpoint: url,
      checks: [
        "fill_bucket from a known water source", "nether_portal edge pour turns a lava pool into obsidian",
        "obsidian mined with a diamond pickaxe", "nether_portal frame snippet builds and lights a portal",
      ],
    }, null, 2));
  } else if (scenario === "collect-blocks-reselection") {
    const scopedStatus = await client.toolCall("get_self_status", {});
    const position = scopedStatus.data?.position;
    if (!scopedStatus.success || !position || ![position.x, position.y, position.z].every(Number.isFinite)) {
      throw new Error(`collect_blocks_reselection scope lacked the current body position: ${JSON.stringify(scopedStatus)}`);
    }
    await runCollectBlocksSmoke(
      runtime, client, Math.floor(position.x), Math.floor(position.y), Math.floor(position.z),
    );
    client.close();
    console.log(JSON.stringify({
      status: "passed",
      scope,
      endpoint: url,
      protocolVersion: info.protocol_version,
      actorUuid: actor.uuid,
      checks: [
        "Agent-facing ID-mode current-feet requery", "two exact target workflows",
        "current-nearest reselection after body movement", "failed stale target left intact",
        "observed-drop collection",
      ],
    }, null, 2));
  } else {
    await runDefaultRuntimeSdkSmoke({
      runtime,
      client,
      scope,
      url,
      token,
      actor,
      info,
      expectedWorldKnowledgeProfile,
      support: {
        runtimeCommand,
        matchingItemCount,
        assertBodyNear,
        waitForBodyOnGround,
        waitForBodyHorizontallyStill,
        activateBlockAfterSettling,
        runMineDownSmoke,
        runTunnelForBlocksSmoke,
        runCollectBlocksSmoke,
        runGotoAndBreakOccludingSmoke,
        runExactBreakOcclusionSmoke,
        stopOccurrences,
        runRealHarnessNativeSurfaceSmoke,
        runRealHarnessExplorationSmoke,
        runSmeltAtFurnaceSmoke,
        runRealHarnessOccurrenceSmoke,
        runRealHarnessLowAirSurfaceSmoke,
      },
    });
  }
} });

if (scenario === "world-knowledge-profile") {
  console.log(JSON.stringify({
    event: "world_knowledge_profile_smoke_passed",
    scope: "profile",
    profile: process.env.EVICRAFT_WORLD_KNOWLEDGE_PROFILE ?? "grounded_evidence",
    server_stopped: true,
    checks: [
      "inside exact block and outside UNKNOWN",
      "bounded block.find",
      "complete and incomplete block.region",
      "block target navigation",
      "knowledge-bound exact PVA-invalid failure without side effect then legal success",
      "Entity Knowledge exact target navigation and interaction",
      "SDK reconnect",
      "death body-unavailable respawn preserves actor and Profile",
    ],
  }));
}
else if (scenario === "simulation-suspension") {
  console.log(JSON.stringify({
    event: "simulation_suspension_smoke_passed",
    scope: "simulation_suspension",
    server_stopped: true,
    game_time: simulationSuspensionReceipt,
    checks: [
      "idle World Run does not advance",
      "SDK RPC stays responsive while paused",
      "wait advances exactly the requested ticks",
      "World Run pauses again after the wait",
    ],
  }));
}
