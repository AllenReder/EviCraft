import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeClient } from "../../../../../runtime/sdk/typescript/dist/index.js";
import { RuntimeAdapter } from "../../../dist/harness/runtime-adapter.js";
import { AbilityRuntime } from "../../../dist/harness/ability-runtime.js";
import { abilities } from "../../../dist/harness/abilities/index.js";
import { assertRuntimeAbilityToolWitnesses } from "../../../dist/smoke/runtime-backed-ability-conformance.js";
import { createRuntimeSdkToolScenarios } from "./sdk-tool-scenarios.mjs";
import { runEntityCollectionCombatSmoke } from "./entity-collection-combat.mjs";
import {
  rejectedStatus,
} from "./benchmark-authority.mjs";
import { runScaffoldPolicySmoke } from "./scaffold-policy.mjs";
import {
  recordingRuntimeClient,
  sameBlockPosition,
} from "./test-context.mjs";

export async function runDefaultRuntimeSdkSmoke({
  runtime,
  client,
  scope,
  url,
  token,
  actor,
  info,
  expectedWorldKnowledgeProfile,
  support,
}) {
  const {
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
  } = support;
  const spawnStatus = await client.toolCall("get_self_status", {});
  const spawnPosition = spawnStatus.data?.position;
  if (!spawnStatus.success || !spawnPosition
      || ![spawnPosition.x, spawnPosition.z].every(Number.isFinite)) {
    throw new Error(`could not establish deterministic smoke terrain: ${JSON.stringify(spawnStatus)}`);
  }
  const fixtureX = Math.floor(spawnPosition.x);
  const fixtureY = 200;
  const fixtureZ = Math.floor(spawnPosition.z);
  await runtimeCommand(runtime,
    `fill ${fixtureX - 12} ${fixtureY - 2} ${fixtureZ - 12} ${fixtureX + 14} ${fixtureY + 6} ${fixtureZ + 12} air`);
  await runtimeCommand(runtime,
    `fill ${fixtureX - 12} ${fixtureY - 1} ${fixtureZ - 12} ${fixtureX + 14} ${fixtureY - 1} ${fixtureZ + 12} stone`);
  await runtimeCommand(runtime,
    `tp bot ${fixtureX + 0.5} ${fixtureY} ${fixtureZ + 0.5} -90 0`);
  await assertBodyNear(client,
    { x: fixtureX + 0.5, y: fixtureY, z: fixtureZ + 0.5 }, "initial evidence setup");

  const refreshed = await client.observe();
  if (refreshed.observation_revision <= actor.observation_revision) {
    throw new Error(`observation.observe did not publish a new observation: ${JSON.stringify({ actor, refreshed })}`);
  }
  actor = await client.actorGet();
  if (actor.observation_revision < refreshed.observation_revision) {
    throw new Error(`actor.get revision lagged observation.observe: ${JSON.stringify({ actor, refreshed })}`);
  }

  const catalogue = await client.toolList();
  assertRuntimeAbilityToolWitnesses(abilities, catalogue.tools);
  const toolNames = catalogue.tools.map((tool) => tool.name);
  if (JSON.stringify(toolNames) !== JSON.stringify([
    "wait", "get_self_status", "get_world_info", "manage_scaffold_materials", "goto", "goto_block_interaction_pose", "goto_block_placement_pose", "break_block", "use_item", "activate_block", "use_item_on_block", "place_block", "enter_bed", "interact_entity",
    "collect_items", "attack", "inspect_gui", "menu_button", "close_gui", "equip_item", "eat",
    "drop_items", "transfer", "lookup_registry", "lookup_recipe", "craft", "throw_eye_of_ender",
  ])) {
    throw new Error(`unexpected Runtime Tool catalogue: ${JSON.stringify(toolNames)}`);
  }
  await runScaffoldPolicySmoke({
    client,
    command: async (command) => await runtimeCommand(runtime, command),
  });
  const selfStatus = await client.toolCall("get_self_status", {});
  if (!selfStatus.success || typeof selfStatus.data?.hunger !== "number"
      || typeof selfStatus.data?.backpack_slots !== "object") {
    throw new Error(`unexpected get_self_status: ${JSON.stringify(selfStatus)}`);
  }
  if ("structures" in selfStatus.data || "structure_membership" in selfStatus.data) {
    throw new Error(`get_self_status exposed structure membership: ${JSON.stringify(selfStatus)}`);
  }
  const bodyPosition = selfStatus.data.position;
  if (!bodyPosition || ![bodyPosition.x, bodyPosition.y, bodyPosition.z].every(Number.isFinite)) {
    throw new Error(`get_self_status omitted the body position: ${JSON.stringify(selfStatus)}`);
  }
  const bodyX = Math.floor(bodyPosition.x);
  const bodyY = Math.floor(bodyPosition.y);
  const bodyZ = Math.floor(bodyPosition.z);
  console.log("smoke: verified Harness block intents and raw break_block through SDK");
  const breakTarget = { x: bodyX + 2, y: bodyY + 1, z: bodyZ };
  await runtimeCommand(runtime,
    `setblock ${breakTarget.x} ${breakTarget.y} ${breakTarget.z} stone`);
  await client.observe();
  await runMineDownSmoke(runtime, client, fixtureX, fixtureY, fixtureZ);
  await runTunnelForBlocksSmoke(runtime, client, fixtureX, fixtureY, fixtureZ);
  await runCollectBlocksSmoke(runtime, client, fixtureX, fixtureY, fixtureZ);
  await runtimeCommand(runtime,
    `tp bot ${fixtureX + 0.5} ${fixtureY} ${fixtureZ + 0.5} -90 0`);
  await client.observe();
  const breakEvidence = await client.blockGet(selfStatus.data.dimension, [breakTarget]);
  if (breakEvidence.cells[0]?.state !== "KNOWN_BLOCK") {
    throw new Error(`break_block target did not become KNOWN_BLOCK: ${JSON.stringify(breakEvidence)}`);
  }
  const harnessAbilityCalls = [];
  const harnessAbilities = new AbilityRuntime({
    onEvent(event) {
      if (event.type === "ability_call_started") harnessAbilityCalls.push(event.ability);
    },
  });
  for (const definition of abilities) await harnessAbilities.register(definition);
  const runtimeToolCalls = [];
  const harnessRuntime = new RuntimeAdapter(recordingRuntimeClient(client, runtimeToolCalls));
  const harnessNames = harnessAbilities.names;
  if (!["break_block", "goto_and_break_block", "goto_and_activate_block", "goto_and_place_block",
    "goto_block_interaction_pose", "goto_block_placement_pose", "activate_block", "use_item_on_block", "place_block", "enter_bed",
    "sleep_in_bed", "smelt_at_furnace"]
    .every((name) => harnessNames.includes(name)) || harnessNames.includes("interact_at")) {
    throw new Error(`Harness final block-intent catalogue is wrong: ${JSON.stringify(harnessNames)}`);
  }
  console.log("smoke: verified goto_block_interaction_pose through Harness adapter");
  const interactionPoseTarget = { x: bodyX + 7, y: bodyY + 1, z: bodyZ };
  await runtimeCommand(runtime,
    `fill ${bodyX - 2} ${bodyY - 1} ${bodyZ - 3} ${interactionPoseTarget.x + 2} ${bodyY + 2} ${bodyZ + 3} air`);
  await runtimeCommand(runtime,
    `fill ${bodyX - 2} ${bodyY - 1} ${bodyZ - 3} ${interactionPoseTarget.x + 2} ${bodyY - 1} ${bodyZ + 3} stone`);
  await runtimeCommand(runtime,
    `setblock ${interactionPoseTarget.x} ${interactionPoseTarget.y} ${interactionPoseTarget.z} obsidian`);
  const interactionPoseFixture = await runtimeCommand(runtime,
    `execute if block ${interactionPoseTarget.x} ${interactionPoseTarget.y} ${interactionPoseTarget.z} obsidian`);
  if (!interactionPoseFixture.includes("Test passed")) {
    throw new Error(`goto_block_interaction_pose fixture was not established: ${JSON.stringify({
      interactionPoseTarget, interactionPoseFixture,
    })}`);
  }
  const interactionPoseSeedX = interactionPoseTarget.x - 2;
  const interactionPoseMidX = Math.floor((bodyX + interactionPoseSeedX) / 2);
  await runtimeCommand(runtime,
    `tp bot ${interactionPoseMidX + 0.5} ${bodyY} ${interactionPoseTarget.z + 0.5} facing ${interactionPoseMidX + 0.5} ${bodyY - 0.5} ${interactionPoseTarget.z + 0.5}`);
  await assertBodyNear(client,
    { x: interactionPoseMidX + 0.5, y: bodyY, z: interactionPoseTarget.z + 0.5 },
    "interaction-pose midpoint evidence seed");
  await client.observe();
  await runtimeCommand(runtime,
    `tp bot ${interactionPoseSeedX + 0.5} ${bodyY} ${interactionPoseTarget.z + 0.5} facing ${interactionPoseSeedX + 0.5} ${bodyY - 0.5} ${interactionPoseTarget.z + 0.5}`);
  await assertBodyNear(client,
    { x: interactionPoseSeedX + 0.5, y: bodyY, z: interactionPoseTarget.z + 0.5 },
    "interaction-pose target evidence seed");
  await client.observe();
  await runtimeCommand(runtime,
    `tp bot ${interactionPoseSeedX + 0.5} ${bodyY} ${interactionPoseTarget.z + 0.5} facing ${interactionPoseTarget.x + 0.5} ${interactionPoseTarget.y + 0.5} ${interactionPoseTarget.z + 0.5}`);
  await client.observe();
  const interactionRoutePositions = [];
  for (let x = bodyX; x <= interactionPoseSeedX; x += 1) {
    interactionRoutePositions.push(
      { x, y: bodyY - 1, z: interactionPoseTarget.z },
      { x, y: bodyY, z: interactionPoseTarget.z },
      { x, y: bodyY + 1, z: interactionPoseTarget.z },
    );
  }
  let interactionPoseEvidence;
  const interactionPoseEvidenceDeadline = Date.now() + 15_000;
  while (Date.now() < interactionPoseEvidenceDeadline) {
    await client.observe();
    interactionPoseEvidence = await client.blockGet(selfStatus.data.dimension,
      [interactionPoseTarget, ...interactionRoutePositions]);
    const targetKnown = interactionPoseEvidence.cells[0]?.state === "KNOWN_BLOCK";
    const routeKnown = interactionPoseEvidence.cells.slice(1).every((cell, index) =>
      cell?.state === (index % 3 === 0 ? "KNOWN_BLOCK" : "KNOWN_AIR"));
    if (targetKnown && routeKnown) break;
    await delay(50);
  }
  const targetKnown = interactionPoseEvidence.cells[0]?.state === "KNOWN_BLOCK";
  const routeKnown = interactionPoseEvidence.cells.slice(1).every((cell, index) =>
    cell?.state === (index % 3 === 0 ? "KNOWN_BLOCK" : "KNOWN_AIR"));
  if (!targetKnown || !routeKnown) {
    throw new Error(`goto_block_interaction_pose route evidence did not converge: ${JSON.stringify(interactionPoseEvidence)}`);
  }
  await runtimeCommand(runtime,
    `tp bot ${bodyX + 0.5} ${bodyY} ${bodyZ + 0.5} -90 0`);
  await assertBodyNear(client,
    { x: bodyX + 0.5, y: bodyY, z: bodyZ + 0.5 }, "interaction-pose navigation start");
  await client.observe();
  const interactionPoseCallStart = runtimeToolCalls.length;
  const interactionPose = await harnessAbilities.dispatch("goto_block_interaction_pose", {
    position: interactionPoseTarget,
  }, {
    runtime: harnessRuntime,
  });
  const interactionPoseRuntimeCalls = runtimeToolCalls.slice(interactionPoseCallStart);
  const interactionPoseTargetPreserved = await runtimeCommand(runtime,
    `execute if block ${interactionPoseTarget.x} ${interactionPoseTarget.y} ${interactionPoseTarget.z} obsidian`);
  if (!interactionPose.ok
      || interactionPose.data?.position?.x !== interactionPoseTarget.x
      || interactionPose.data?.position?.y !== interactionPoseTarget.y
      || interactionPose.data?.position?.z !== interactionPoseTarget.z
      || !Number.isInteger(interactionPose.data?.feet?.x)
      || !Number.isInteger(interactionPose.data?.feet?.y)
      || !Number.isInteger(interactionPose.data?.feet?.z)
      || JSON.stringify(interactionPoseRuntimeCalls) !== JSON.stringify([{
        name: "goto_block_interaction_pose",
        args: { position: interactionPoseTarget },
      }])
      || !interactionPoseTargetPreserved.includes("Test passed")) {
    throw new Error(`goto_block_interaction_pose did not return a verified protected pose: ${JSON.stringify({
      interactionPose, interactionPoseRuntimeCalls, interactionPoseTargetPreserved,
    })}`);
  }
  await runtimeCommand(runtime,
    `tp bot ${bodyX + 0.5} ${bodyY} ${bodyZ + 0.5} -90 0`);
  console.log("smoke: verified distance sleep_in_bed through Harness peers");
  const bedFoot = { x: bodyX - 1, y: bodyY, z: bodyZ - 2 };
  const bedHead = { x: bodyX - 2, y: bodyY, z: bodyZ - 2 };
  await runtimeCommand(runtime,
    `setblock ${bedFoot.x} ${bedFoot.y} ${bedFoot.z} red_bed[part=foot,facing=west,occupied=false]`);
  await runtimeCommand(runtime,
    `setblock ${bedHead.x} ${bedHead.y} ${bedHead.z} red_bed[part=head,facing=west,occupied=false]`);
  await runtimeCommand(runtime, "time set night");
  let rememberedBeds;
  let fixtureHalves = [];
  const rememberedBedsDeadline = Date.now() + 15_000;
  while (Date.now() < rememberedBedsDeadline) {
    await client.observe();
    rememberedBeds = await client.blockFind(selfStatus.data.dimension, "minecraft:*_bed", {
      origin: { x: bodyX, y: bodyY, z: bodyZ },
      limit: 32,
    });
    fixtureHalves = rememberedBeds.matches.filter(({ position }) =>
      position.y === bedHead.y && position.z === bedHead.z
      && (position.x === bedFoot.x || position.x === bedHead.x));
    if (fixtureHalves.length === 2) break;
    await delay(50);
  }
  if (fixtureHalves.length !== 2) {
    throw new Error(`sleep_in_bed fixture halves did not become remembered: ${JSON.stringify({
      rememberedBeds, bedFoot, bedHead,
    })}`);
  }
  const sleptInBed = await harnessAbilities.dispatch("sleep_in_bed", { distance: 8 }, {
    runtime: new RuntimeAdapter(client),
  });
  const attemptedBed = sleptInBed.data?.attempted_candidates?.[0];
  if (!sleptInBed.ok || sleptInBed.data?.position?.x !== bedHead.x
      || sleptInBed.data?.position?.y !== bedHead.y
      || sleptInBed.data?.position?.z !== bedHead.z
      || sleptInBed.data?.attempted_candidates?.length !== 1
      || attemptedBed?.position?.x !== bedHead.x
      || attemptedBed?.position?.y !== bedHead.y
      || attemptedBed?.position?.z !== bedHead.z
      || attemptedBed?.enter_bed?.ok !== true
      || attemptedBed?.enter_bed?.data?.sleeping !== true) {
    throw new Error(`Harness sleep_in_bed did not deduplicate and verify sleep: ${JSON.stringify({
      sleptInBed, bedFoot, bedHead,
    })}`);
  }
  await runtimeCommand(runtime, "time set day");
  await delay(100);
  await runtimeCommand(runtime,
    `fill ${bedFoot.x} ${bedFoot.y} ${bedFoot.z} ${bedHead.x} ${bedHead.y} ${bedHead.z} air`);
  await runtimeCommand(runtime, "kill @e[type=minecraft:item]");
  await runtimeCommand(runtime,
    `tp bot ${bodyX + 0.5} ${bodyY} ${bodyZ + 0.5} -90 0`);
  await delay(100);
  await assertBodyNear(client,
    { x: bodyX + 0.5, y: bodyY, z: bodyZ + 0.5 }, "post-sleep_in_bed fixture restore");
  await client.observe();
  console.log("smoke: compact goto_and_break_block approaches through Harness peers");
  await runtimeCommand(runtime,
    `fill ${bodyX - 2} ${bodyY - 1} ${bodyZ - 3} ${interactionPoseTarget.x + 2} ${bodyY + 2} ${bodyZ + 3} air`);
  await runtimeCommand(runtime,
    `fill ${bodyX - 2} ${bodyY - 1} ${bodyZ - 3} ${interactionPoseTarget.x + 2} ${bodyY - 1} ${bodyZ + 3} stone`);
  await runtimeCommand(runtime,
    `setblock ${interactionPoseTarget.x} ${interactionPoseTarget.y} ${interactionPoseTarget.z} stone`);
  await runtimeCommand(runtime,
    `tp bot ${interactionPoseMidX + 0.5} ${bodyY} ${interactionPoseTarget.z + 0.5} facing ${interactionPoseMidX + 0.5} ${bodyY - 0.5} ${interactionPoseTarget.z + 0.5}`);
  await assertBodyNear(client,
    { x: interactionPoseMidX + 0.5, y: bodyY, z: interactionPoseTarget.z + 0.5 },
    "goto_and_break_block midpoint evidence seed");
  await client.observe();
  await runtimeCommand(runtime,
    `tp bot ${interactionPoseSeedX + 0.5} ${bodyY} ${interactionPoseTarget.z + 0.5} facing ${interactionPoseSeedX + 0.5} ${bodyY - 0.5} ${interactionPoseTarget.z + 0.5}`);
  await assertBodyNear(client,
    { x: interactionPoseSeedX + 0.5, y: bodyY, z: interactionPoseTarget.z + 0.5 },
    "goto_and_break_block target evidence seed");
  await client.observe();
  await runtimeCommand(runtime,
    `tp bot ${interactionPoseSeedX + 0.5} ${bodyY} ${interactionPoseTarget.z + 0.5} facing ${interactionPoseTarget.x + 0.5} ${interactionPoseTarget.y + 0.5} ${interactionPoseTarget.z + 0.5}`);
  let compositeBreakRouteEvidence;
  const compositeBreakRouteDeadline = Date.now() + 15_000;
  while (Date.now() < compositeBreakRouteDeadline) {
    await client.observe();
    compositeBreakRouteEvidence = await client.blockGet(selfStatus.data.dimension,
      [interactionPoseTarget, ...interactionRoutePositions]);
    const compositeTargetKnown = compositeBreakRouteEvidence.cells[0]?.state === "KNOWN_BLOCK";
    const compositeRouteKnown = compositeBreakRouteEvidence.cells.slice(1).every((cell, index) =>
      cell?.state === (index % 3 === 0 ? "KNOWN_BLOCK" : "KNOWN_AIR"));
    if (compositeTargetKnown && compositeRouteKnown) break;
    await delay(50);
  }
  const compositeTargetKnown = compositeBreakRouteEvidence.cells[0]?.state === "KNOWN_BLOCK";
  const compositeRouteKnown = compositeBreakRouteEvidence.cells.slice(1).every((cell, index) =>
    cell?.state === (index % 3 === 0 ? "KNOWN_BLOCK" : "KNOWN_AIR"));
  if (!compositeTargetKnown || !compositeRouteKnown) {
    throw new Error(`goto_and_break_block route evidence did not converge: ${JSON.stringify(
      compositeBreakRouteEvidence)}`);
  }
  await runtimeCommand(runtime,
    `tp bot ${bodyX + 0.5} ${bodyY} ${bodyZ + 0.5} -90 0`);
  await assertBodyNear(client,
    { x: bodyX + 0.5, y: bodyY, z: bodyZ + 0.5 },
    "goto_and_break_block navigation start");
  await client.observe();
  const compositeBreakCallStart = harnessAbilityCalls.length;
  const compositeBroken = await harnessAbilities.dispatch("goto_and_break_block", {
    position: interactionPoseTarget,
  }, {
    runtime: new RuntimeAdapter(client),
  });
  const compositeBreakCalls = harnessAbilityCalls.slice(compositeBreakCallStart);
  const compositeBrokenPhysical = await runtimeCommand(runtime,
    `execute unless block ${interactionPoseTarget.x} ${interactionPoseTarget.y} ${interactionPoseTarget.z} stone`);
  if (!compositeBroken.ok
      || JSON.stringify(Object.keys(compositeBroken.data ?? {})) !== JSON.stringify([
        "position", "observed_drop_entities", "cleared_occluding_blocks",
      ])
      || !sameBlockPosition(compositeBroken.data?.position, interactionPoseTarget)
      || !Array.isArray(compositeBroken.data?.observed_drop_entities)
      || compositeBroken.data?.cleared_occluding_blocks?.length !== 0
      || compositeBreakCalls.filter((name) => name === "break_block").length !== 2
      || compositeBreakCalls.filter((name) => name === "goto_block_interaction_pose").length !== 1
      || !compositeBrokenPhysical.includes("Test passed")) {
    throw new Error(`goto_and_break_block did not compactly approach its frozen target: ${JSON.stringify({
      compositeBroken, compositeBreakCalls, compositeBrokenPhysical,
    })}`);
  }
  console.log("smoke: compact goto_and_activate_block approaches and retries through Harness peers");
  await runtimeCommand(runtime,
    `setblock ${interactionPoseTarget.x} ${interactionPoseTarget.y} ${interactionPoseTarget.z} crafting_table`);
  let compositeActivationEvidence;
  const compositeActivationEvidenceDeadline = Date.now() + 15_000;
  while (Date.now() < compositeActivationEvidenceDeadline) {
    await client.observe();
    compositeActivationEvidence = await client.blockGet(
      selfStatus.data.dimension, [interactionPoseTarget]);
    if (compositeActivationEvidence.cells[0]?.state === "KNOWN_BLOCK") break;
    await delay(50);
  }
  if (compositeActivationEvidence.cells[0]?.state !== "KNOWN_BLOCK") {
    throw new Error(`goto_and_activate_block target did not become KNOWN_BLOCK: ${JSON.stringify(
      compositeActivationEvidence)}`);
  }
  await runtimeCommand(runtime,
    `setblock ${interactionPoseTarget.x - 1} ${interactionPoseTarget.y} ${interactionPoseTarget.z} bedrock`);
  await runtimeCommand(runtime,
    `tp bot ${interactionPoseTarget.x - 1.5} ${bodyY} ${interactionPoseTarget.z + 0.5} -90 0`);
  const activationCallStart = harnessAbilityCalls.length;
  const compositeActivated = await harnessAbilities.dispatch("goto_and_activate_block", {
    position: interactionPoseTarget,
  }, {
    runtime: new RuntimeAdapter(client),
  });
  const activationCalls = harnessAbilityCalls.slice(activationCallStart);
  if (!compositeActivated.ok
      || JSON.stringify(Object.keys(compositeActivated.data ?? {})) !== JSON.stringify(["position", "outcome"])
      || compositeActivated.data?.outcome !== "menu_opened"
      || !sameBlockPosition(compositeActivated.data?.position, interactionPoseTarget)
      || activationCalls.filter((name) => name === "activate_block").length !== 2
      || activationCalls.filter((name) => name === "goto_block_interaction_pose").length !== 1
      || activationCalls.includes("break_block")) {
    throw new Error(`goto_and_activate_block did not compactly approach and retry without breaking: ${JSON.stringify({
      compositeActivated, activationCalls,
    })}`);
  }
  const closeMenuCallStart = runtimeToolCalls.length;
  const compositeClosed = await harnessAbilities.dispatch("close_menu", {}, {
    runtime: harnessRuntime,
  });
  const closeMenuRuntimeCalls = runtimeToolCalls.slice(closeMenuCallStart);
  if (!compositeClosed.ok
      || JSON.stringify(closeMenuRuntimeCalls) !== JSON.stringify([{
        name: "close_gui", args: {},
      }])) {
    throw new Error(`close_menu did not execute its aliased close_gui Runtime Tool: ${JSON.stringify({
      compositeClosed, closeMenuRuntimeCalls,
    })}`);
  }
  if (process.env.EVICRAFT_SMOKE_SCOPE === "activation") {
    client.close();
    console.log(JSON.stringify({
      status: "passed",
      scope: "activation",
      endpoint: url,
      protocolVersion: info.protocol_version,
      actorUuid: actor.uuid,
      checks: [
        "Agent-facing goto_and_activate_block exact compact outcome",
        "out-of-reach or occluded activation approach",
        "one interaction-pose search", "one activation retry", "no break_block dispatch",
      ],
    }, null, 2));
  } else {
    await runGotoAndBreakOccludingSmoke(runtime, client, selfStatus.data.dimension);
    await runtimeCommand(runtime,
    `tp bot ${bodyX + 0.5} ${bodyY} ${bodyZ + 0.5} -90 0`);
  await runtimeCommand(runtime,
    `setblock ${breakTarget.x} ${breakTarget.y} ${breakTarget.z} stone`);
  await client.observe();
  const refreshedBreakEvidence = await client.blockGet(
    selfStatus.data.dimension, [breakTarget]);
  if (refreshedBreakEvidence.cells[0]?.state !== "KNOWN_BLOCK") {
    throw new Error(`break_block target did not refresh after interaction fixtures: ${JSON.stringify(
      refreshedBreakEvidence)}`);
  }
  const breakBlockCallStart = runtimeToolCalls.length;
  const broken = await harnessAbilities.dispatch("break_block", { position: breakTarget }, {
    runtime: harnessRuntime,
  });
  const breakBlockRuntimeCalls = runtimeToolCalls.slice(breakBlockCallStart);
  const brokenPhysical = await runtimeCommand(runtime,
    `execute if block ${breakTarget.x} ${breakTarget.y} ${breakTarget.z} air`);
  if (!broken.ok || Object.keys(broken.data).length !== 2
      || broken.data?.position?.x !== breakTarget.x
      || broken.data?.position?.y !== breakTarget.y
      || broken.data?.position?.z !== breakTarget.z
      || !Array.isArray(broken.data?.observed_drop_entities)
      || broken.data.observed_drop_entities.length !== 0
      || JSON.stringify(breakBlockRuntimeCalls) !== JSON.stringify([{
        name: "break_block",
        args: { position: breakTarget },
      }])
      || !brokenPhysical.includes("Test passed")) {
    throw new Error(`Harness break_block did not verify only exact disappearance: ${JSON.stringify({
      broken, breakBlockRuntimeCalls, brokenPhysical,
    })}`);
  }
  const rawBreakTarget = { ...breakTarget, z: breakTarget.z + 2 };
  await runtimeCommand(runtime,
    `setblock ${rawBreakTarget.x} ${rawBreakTarget.y} ${rawBreakTarget.z} stone`);
  await client.observe();
  const rawBroken = await client.toolCall("break_block", { position: rawBreakTarget });
  const rawBrokenPhysical = await runtimeCommand(runtime,
    `execute if block ${rawBreakTarget.x} ${rawBreakTarget.y} ${rawBreakTarget.z} air`);
  if (!rawBroken.success || Object.keys(rawBroken.data ?? {}).length !== 2
      || rawBroken.data?.position?.x !== rawBreakTarget.x
      || rawBroken.data?.position?.y !== rawBreakTarget.y
      || rawBroken.data?.position?.z !== rawBreakTarget.z
      || !Array.isArray(rawBroken.data?.observed_drop_entities)
      || rawBroken.data.observed_drop_entities.length !== 0
      || !rawBrokenPhysical.includes("Test passed")) {
    throw new Error(`raw Runtime break_block was not retained below the Adapter: ${JSON.stringify({
      rawBroken, rawBrokenPhysical,
    })}`);
  }
  console.log("smoke: verified activate_block through Harness adapter");
  const activationTarget = { x: bodyX + 2, y: bodyY + 1, z: bodyZ };
  await runtimeCommand(runtime,
    `setblock ${activationTarget.x} ${activationTarget.y} ${activationTarget.z} chest`);
  await runtimeCommand(runtime, "clear bot");
  await runtimeCommand(runtime,
    "item replace entity bot weapon.mainhand with minecraft:diamond_axe 1");
  await runtimeCommand(runtime,
    "item replace entity bot weapon.offhand with minecraft:cobblestone 1");
  await client.observe();
  const activationEvidence = await client.blockGet(
    selfStatus.data.dimension, [activationTarget]);
  if (activationEvidence.cells[0]?.state !== "KNOWN_BLOCK") {
    throw new Error(`activate_block target did not become KNOWN_BLOCK: ${JSON.stringify(activationEvidence)}`);
  }
  const activated = await harnessAbilities.dispatch("activate_block", { position: activationTarget }, {
    runtime: new RuntimeAdapter(client),
  });
  const axeAfterActivation = await matchingItemCount(runtime, "bot", "minecraft:diamond_axe");
  const offhandAfterActivation = await matchingItemCount(runtime, "bot", "minecraft:cobblestone");
  if (!activated.ok || activated.data?.outcome !== "menu_opened"
      || activated.data?.position?.x !== activationTarget.x
      || activated.data?.position?.y !== activationTarget.y
      || activated.data?.position?.z !== activationTarget.z
      || axeAfterActivation !== 1 || offhandAfterActivation !== 1) {
    throw new Error(`activate_block did not verify and restore exact body state: ${JSON.stringify({
      activated, axeAfterActivation, offhandAfterActivation,
    })}`);
  }
  const closedActivationMenu = await client.toolCall("close_gui", {});
  if (!closedActivationMenu.success) {
    throw new Error(`activate_block Menu did not close cleanly: ${JSON.stringify(closedActivationMenu)}`);
  }
  console.log("smoke: verified use_item_on_block through Harness adapter");
  await runtimeCommand(runtime, "gamemode survival bot");
  const itemUseTarget = { x: bodyX + 2, y: bodyY + 1, z: bodyZ };
  await runtimeCommand(runtime,
    `fill ${itemUseTarget.x - 1} ${itemUseTarget.y - 1} ${itemUseTarget.z - 1} ${itemUseTarget.x + 1} ${itemUseTarget.y - 1} ${itemUseTarget.z + 1} stone`);
  await runtimeCommand(runtime,
    `fill ${itemUseTarget.x - 1} ${itemUseTarget.y} ${itemUseTarget.z - 1} ${itemUseTarget.x + 1} ${itemUseTarget.y + 1} ${itemUseTarget.z + 1} air`);
  await runtimeCommand(runtime,
    `setblock ${itemUseTarget.x} ${itemUseTarget.y} ${itemUseTarget.z} obsidian`);
  await runtimeCommand(runtime, "clear bot");
  await runtimeCommand(runtime, "item replace entity bot weapon.mainhand with minecraft:diamond_axe 1");
  await runtimeCommand(runtime, "item replace entity bot weapon.offhand with minecraft:cobblestone 1");
  await runtimeCommand(runtime,
    "item replace entity bot inventory.0 with minecraft:flint_and_steel 1");
  const selectedBeforeItemUse = await runtimeCommand(runtime, "data get entity bot SelectedItemSlot");
  await client.observe();
  const itemUseEvidence = await client.blockGet(
    selfStatus.data.dimension, [itemUseTarget]);
  if (itemUseEvidence.cells[0]?.state !== "KNOWN_BLOCK") {
    throw new Error(`use_item_on_block target did not become KNOWN_BLOCK: ${JSON.stringify(itemUseEvidence)}`);
  }
  const itemUsed = await harnessAbilities.dispatch("use_item_on_block", {
    item_id: "minecraft:flint_and_steel",
    position: itemUseTarget,
  }, {
    runtime: new RuntimeAdapter(client),
  });
  const faceOffsets = {
    down: { x: 0, y: -1, z: 0 }, up: { x: 0, y: 1, z: 0 },
    north: { x: 0, y: 0, z: -1 }, south: { x: 0, y: 0, z: 1 },
    west: { x: -1, y: 0, z: 0 }, east: { x: 1, y: 0, z: 0 },
  };
  const itemUseOffset = faceOffsets[itemUsed.data?.face];
  const expectedEffectPosition = itemUseOffset === undefined ? null : {
    x: itemUseTarget.x + itemUseOffset.x,
    y: itemUseTarget.y + itemUseOffset.y,
    z: itemUseTarget.z + itemUseOffset.z,
  };
  const fireAfterItemUse = expectedEffectPosition === null ? "" : await runtimeCommand(runtime,
    `execute if block ${expectedEffectPosition.x} ${expectedEffectPosition.y} ${expectedEffectPosition.z} minecraft:fire`);
  const damagedFlintAfterItemUse = await runtimeCommand(runtime,
    "execute if items entity bot inventory.0 minecraft:flint_and_steel[minecraft:damage=1]");
  const selectedAfterItemUse = await runtimeCommand(runtime, "data get entity bot SelectedItemSlot");
  const axeAfterItemUse = await matchingItemCount(runtime, "bot", "minecraft:diamond_axe");
  const offhandAfterItemUse = await matchingItemCount(runtime, "bot", "minecraft:cobblestone");
  const flintAfterItemUse = await matchingItemCount(runtime, "bot", "minecraft:flint_and_steel");
  if (!itemUsed.ok || itemUsed.data?.outcome !== "adjacent_block_changed"
      || itemUsed.data?.item_id !== "minecraft:flint_and_steel"
      || itemUsed.data?.consumed_count !== 0 || itemUsed.data?.durability_used !== 1
      || expectedEffectPosition === null
      || itemUsed.data?.effect_position?.x !== expectedEffectPosition.x
      || itemUsed.data?.effect_position?.y !== expectedEffectPosition.y
      || itemUsed.data?.effect_position?.z !== expectedEffectPosition.z
      || !itemUsed.data?.block_state?.startsWith("minecraft:fire[")
      || !fireAfterItemUse.includes("Test passed")
      || !damagedFlintAfterItemUse.includes("Test passed")
      || selectedAfterItemUse !== selectedBeforeItemUse
      || axeAfterItemUse !== 1 || offhandAfterItemUse !== 1 || flintAfterItemUse !== 1) {
    throw new Error(`use_item_on_block did not verify its exact effect and restore body state: ${JSON.stringify({
      itemUsed, expectedEffectPosition, fireAfterItemUse, damagedFlintAfterItemUse,
      selectedBeforeItemUse, selectedAfterItemUse, axeAfterItemUse,
      offhandAfterItemUse, flintAfterItemUse,
    })}`);
  }
  await runtimeCommand(runtime,
    `fill ${itemUseTarget.x - 1} ${itemUseTarget.y - 1} ${itemUseTarget.z - 1} ${itemUseTarget.x + 1} ${itemUseTarget.y + 1} ${itemUseTarget.z + 1} air`);
  console.log("smoke: verified place_block through Harness adapter");
  const placementTarget = { x: bodyX + 2, y: bodyY, z: bodyZ + 3 };
  const placementSupport = { ...placementTarget, y: placementTarget.y - 1 };
  await runtimeCommand(runtime,
    `fill ${placementTarget.x - 2} ${placementTarget.y} ${placementTarget.z - 2} ${placementTarget.x + 2} ${placementTarget.y + 2} ${placementTarget.z + 2} air`);
  await runtimeCommand(runtime,
    `fill ${placementTarget.x - 2} ${placementSupport.y} ${placementTarget.z - 2} ${placementTarget.x + 2} ${placementSupport.y} ${placementTarget.z + 2} stone`);
  await runtimeCommand(runtime,
    `setblock ${placementSupport.x} ${placementSupport.y} ${placementSupport.z} stone`);
  await runtimeCommand(runtime, "clear bot");
  await runtimeCommand(runtime,
    "item replace entity bot weapon.mainhand with minecraft:diamond_axe 1");
  await runtimeCommand(runtime,
    "item replace entity bot weapon.offhand with minecraft:diamond_block 1");
  await runtimeCommand(runtime,
    "item replace entity bot inventory.1 with minecraft:oak_stairs 3");
  const selectedBeforePlacement = await runtimeCommand(runtime,
    "data get entity bot SelectedItemSlot");
  await client.observe();
  const placementEvidence = await client.blockGet(
    selfStatus.data.dimension, [placementTarget, placementSupport]);
  if (placementEvidence.cells[0]?.state !== "KNOWN_AIR"
      || placementEvidence.cells[1]?.state !== "KNOWN_BLOCK") {
    throw new Error(`place_block fixture lacked exact target/support evidence: ${JSON.stringify(placementEvidence)}`);
  }
  console.log("smoke: verified goto_block_placement_pose through Harness adapter");
  const placementPose = await harnessAbilities.dispatch("goto_block_placement_pose", {
    item_id: "minecraft:oak_stairs",
    position: placementTarget,
  }, {
    runtime: new RuntimeAdapter(client),
  });
  const placementPoseEvidence = await client.blockGet(
    selfStatus.data.dimension, [placementTarget, placementSupport]);
  const selectedAfterPlacementPose = await runtimeCommand(runtime,
    "data get entity bot SelectedItemSlot");
  const mainHandAfterPlacementPose = await runtimeCommand(runtime,
    "execute if items entity bot weapon.mainhand minecraft:diamond_axe");
  const offhandAfterPlacementPose = await runtimeCommand(runtime,
    "execute if items entity bot weapon.offhand minecraft:diamond_block");
  const stairsAfterPlacementPose = await matchingItemCount(runtime, "bot", "minecraft:oak_stairs");
  if (!placementPose.ok || placementPose.data?.item_id !== "minecraft:oak_stairs"
      || placementPose.data?.position?.x !== placementTarget.x
      || placementPose.data?.position?.y !== placementTarget.y
      || placementPose.data?.position?.z !== placementTarget.z
      || !Number.isInteger(placementPose.data?.feet?.x)
      || !Number.isInteger(placementPose.data?.feet?.y)
      || !Number.isInteger(placementPose.data?.feet?.z)
      || Object.keys(placementPose.data).sort().join(",") !== "feet,item_id,position"
      || placementPoseEvidence.cells[0]?.state !== "KNOWN_AIR"
      || placementPoseEvidence.cells[1]?.state !== "KNOWN_BLOCK"
      || selectedAfterPlacementPose !== selectedBeforePlacement
      || !mainHandAfterPlacementPose.includes("Test passed")
      || !offhandAfterPlacementPose.includes("Test passed")
      || stairsAfterPlacementPose !== 3) {
    throw new Error(`goto_block_placement_pose did not verify a non-mutating exact context: ${JSON.stringify({
      placementPose, placementPoseEvidence, selectedBeforePlacement, selectedAfterPlacementPose,
      mainHandAfterPlacementPose, offhandAfterPlacementPose, stairsAfterPlacementPose,
    })}`);
  }
  const placed = await harnessAbilities.dispatch("place_block", {
    item_id: "minecraft:oak_stairs",
    position: placementTarget,
  }, {
    runtime: new RuntimeAdapter(client),
  });
  const placedEvidence = await client.blockGet(
    selfStatus.data.dimension, [placementTarget]);
  const selectedAfterPlacement = await runtimeCommand(runtime,
    "data get entity bot SelectedItemSlot");
  const mainHandAfterPlacement = await runtimeCommand(runtime,
    "execute if items entity bot weapon.mainhand minecraft:diamond_axe");
  const offhandAfterPlacement = await runtimeCommand(runtime,
    "execute if items entity bot weapon.offhand minecraft:diamond_block");
  const sourceAfterPlacement = await runtimeCommand(runtime,
    "execute if items entity bot inventory.1 minecraft:oak_stairs");
  const stairsAfterPlacement = await matchingItemCount(runtime, "bot", "minecraft:oak_stairs");
  if (!placed.ok || placed.data?.item_id !== "minecraft:oak_stairs"
      || placed.data?.position?.x !== placementTarget.x
      || placed.data?.position?.y !== placementTarget.y
      || placed.data?.position?.z !== placementTarget.z
      || !placed.data?.block_state?.startsWith("minecraft:oak_stairs[")
      || placed.data?.consumed_count !== 1
      || placedEvidence.cells[0]?.state !== "KNOWN_BLOCK"
      || placedEvidence.cells[0]?.block_state !== placed.data.block_state
      || selectedAfterPlacement !== selectedBeforePlacement
      || !mainHandAfterPlacement.includes("Test passed")
      || !offhandAfterPlacement.includes("Test passed")
      || !sourceAfterPlacement.includes("Test passed")
      || stairsAfterPlacement !== 2) {
    throw new Error(`place_block did not verify actual state, consumption, and restoration: ${JSON.stringify({
      placed, placedEvidence, selectedBeforePlacement, selectedAfterPlacement,
      mainHandAfterPlacement, offhandAfterPlacement, sourceAfterPlacement,
      stairsAfterPlacement,
    })}`);
  }
  console.log("smoke: conditional goto_and_place_block approaches and places through Harness peers");
  const compositePlacementTarget = { x: bodyX + 7, y: bodyY, z: bodyZ };
  const compositePlacementSupport = {
    x: compositePlacementTarget.x,
    y: compositePlacementTarget.y - 1,
    z: compositePlacementTarget.z,
  };
  await runtimeCommand(runtime,
    `fill ${bodyX - 2} ${bodyY - 2} ${bodyZ - 3} ${compositePlacementTarget.x + 2} ${bodyY + 3} ${bodyZ + 3} air`);
  await runtimeCommand(runtime,
    `fill ${bodyX - 2} ${bodyY - 1} ${bodyZ - 3} ${compositePlacementTarget.x + 2} ${bodyY - 1} ${bodyZ + 3} stone`);
  await runtimeCommand(runtime, "clear bot");
  await runtimeCommand(runtime, "give bot minecraft:cobblestone 1");
  const compositePlacementSeedX = compositePlacementTarget.x - 2;
  await runtimeCommand(runtime,
    `tp bot ${compositePlacementSeedX + 0.5} ${bodyY} ${bodyZ + 0.5} facing ${compositePlacementTarget.x + 0.5} ${bodyY + 0.5} ${bodyZ + 0.5}`);
  await assertBodyNear(client,
    { x: compositePlacementSeedX + 0.5, y: bodyY, z: bodyZ + 0.5 },
    "goto_and_place_block target evidence seed");
  await client.observe();
  await runtimeCommand(runtime, `tp bot ${bodyX + 0.5} ${bodyY} ${bodyZ + 0.5} -90 0`);
  await assertBodyNear(client,
    { x: bodyX + 0.5, y: bodyY, z: bodyZ + 0.5 },
    "goto_and_place_block navigation start");
  const compositePlacementRoutePositions = [];
  for (let x = bodyX; x <= compositePlacementTarget.x; x += 1) {
    compositePlacementRoutePositions.push(
      { x, y: bodyY - 1, z: bodyZ },
      { x, y: bodyY, z: bodyZ },
      { x, y: bodyY + 1, z: bodyZ },
    );
  }
  let compositePlacementEvidence;
  const compositePlacementEvidenceDeadline = Date.now() + 15_000;
  while (Date.now() < compositePlacementEvidenceDeadline) {
    await client.observe();
    compositePlacementEvidence = await client.blockGet(selfStatus.data.dimension, [
      compositePlacementTarget, compositePlacementSupport, ...compositePlacementRoutePositions,
    ]);
    const targetKnownAir = compositePlacementEvidence.cells[0]?.state === "KNOWN_AIR";
    const supportKnown = compositePlacementEvidence.cells[1]?.state === "KNOWN_BLOCK";
    const routeKnown = compositePlacementEvidence.cells.slice(2).every((cell, index) =>
      cell?.state === (index % 3 === 0 ? "KNOWN_BLOCK" : "KNOWN_AIR"));
    if (targetKnownAir && supportKnown && routeKnown) break;
    await delay(50);
  }
  const compositePlacementTargetKnown = compositePlacementEvidence.cells[0]?.state === "KNOWN_AIR";
  const compositePlacementSupportKnown = compositePlacementEvidence.cells[1]?.state === "KNOWN_BLOCK";
  const compositePlacementRouteKnown = compositePlacementEvidence.cells.slice(2).every((cell, index) =>
    cell?.state === (index % 3 === 0 ? "KNOWN_BLOCK" : "KNOWN_AIR"));
  if (!compositePlacementTargetKnown || !compositePlacementSupportKnown || !compositePlacementRouteKnown) {
    throw new Error(`goto_and_place_block fixture evidence did not converge: ${JSON.stringify({
      compositePlacementTarget, compositePlacementSupport, compositePlacementEvidence,
    })}`);
  }
  const compositePlaced = await harnessAbilities.dispatch("goto_and_place_block", {
    item_id: "minecraft:cobblestone",
    position: compositePlacementTarget,
  }, {
    runtime: new RuntimeAdapter(client),
  });
  const compositePlacedPhysical = await runtimeCommand(runtime,
    `execute if block ${compositePlacementTarget.x} ${compositePlacementTarget.y} ${compositePlacementTarget.z} minecraft:cobblestone`);
  const cobblestoneAfterCompositePlacement = await matchingItemCount(
    runtime, "bot", "minecraft:cobblestone");
  if (!compositePlaced.ok
      || compositePlaced.data?.action !== "place_block"
      || compositePlaced.data?.item_id !== "minecraft:cobblestone"
      || compositePlaced.data?.position?.x !== compositePlacementTarget.x
      || compositePlaced.data?.position?.y !== compositePlacementTarget.y
      || compositePlaced.data?.position?.z !== compositePlacementTarget.z
      || compositePlaced.data?.initial?.ok !== false
      || !["out_of_reach", "occluded"].includes(compositePlaced.data?.initial?.data?.failure_type)
      || compositePlaced.data?.approach?.ok !== true
      || compositePlaced.data?.retry?.ok !== true
      || !compositePlacedPhysical.includes("Test passed")
      || cobblestoneAfterCompositePlacement !== 0) {
    throw new Error(`goto_and_place_block did not conditionally approach and place: ${JSON.stringify({
      compositePlaced, compositePlacedPhysical, cobblestoneAfterCompositePlacement,
    })}`);
  }
  await runtimeCommand(runtime, "clear bot");
  const registryLookup = await client.toolCall("lookup_registry", { kind: "item", query: "Iron Ingot" });
  if (!registryLookup.success
      || registryLookup.data?.candidates?.[0]?.id !== "minecraft:iron_ingot"
      || registryLookup.data?.candidates?.length > 8) {
    throw new Error(`lookup_registry did not return bounded English-name knowledge: ${JSON.stringify(registryLookup)}`);
  }
  const registryProbeStatusBefore = await waitForBodyHorizontallyStill(
    client, "lookup_registry mutation probe");
  const registryProbePosition = registryProbeStatusBefore.data?.position;
  if (!registryProbeStatusBefore.success || !registryProbePosition) {
    throw new Error(`lookup_registry mutation probe lacked a current body position: ${JSON.stringify(registryProbeStatusBefore)}`);
  }
  const registrySentinel = {
    x: Math.floor(registryProbePosition.x) + 24,
    y: 250,
    z: Math.floor(registryProbePosition.z) + 24,
  };
  await runtimeCommand(runtime,
    `setblock ${registrySentinel.x} ${registrySentinel.y} ${registrySentinel.z} minecraft:diamond_block`);
  const registryStickCountBefore = await matchingItemCount(runtime, "bot", "minecraft:stick");
  const entityRegistryLookup = await client.toolCall("lookup_registry", { kind: "entity", query: "zombie" });
  const broadEntityRegistryLookup = await client.toolCall("lookup_registry", {
    kind: "entity",
    query: "minecraft",
  });
  const unknownEntityRegistryLookup = await client.toolCall("lookup_registry", {
    kind: "entity",
    query: "no_such_entity_type_probe",
  });
  const registryProbeStatusAfter = await client.toolCall("get_self_status", {});
  const registryStickCountAfter = await matchingItemCount(runtime, "bot", "minecraft:stick");
  const registrySentinelAfter = await runtimeCommand(runtime,
    `execute if block ${registrySentinel.x} ${registrySentinel.y} ${registrySentinel.z} minecraft:diamond_block`);
  await runtimeCommand(runtime,
    `setblock ${registrySentinel.x} ${registrySentinel.y} ${registrySentinel.z} minecraft:air`);
  if (!entityRegistryLookup.success
      || entityRegistryLookup.data?.candidates?.[0]?.id !== "minecraft:zombie"
      || entityRegistryLookup.data?.candidates?.length !== 1
      || entityRegistryLookup.data?.truncated !== false
      || !broadEntityRegistryLookup.success
      || broadEntityRegistryLookup.data?.candidates?.length !== 8
      || broadEntityRegistryLookup.data?.candidates?.some((candidate) => candidate.kind !== "entity")
      || broadEntityRegistryLookup.data?.truncated !== true
      || !unknownEntityRegistryLookup.success
      || unknownEntityRegistryLookup.data?.candidates?.length !== 0
      || unknownEntityRegistryLookup.data?.truncated !== false
      || !registryProbeStatusAfter.success
      || JSON.stringify(registryProbeStatusAfter.data?.position) !== JSON.stringify(registryProbePosition)
      || registryStickCountAfter !== registryStickCountBefore
      || !registrySentinelAfter.includes("Test passed")) {
    throw new Error(`lookup_registry did not preserve bounded entity knowledge semantics: ${JSON.stringify({
      entityRegistryLookup, broadEntityRegistryLookup, unknownEntityRegistryLookup,
      registryProbeStatusBefore, registryProbeStatusAfter,
      registryStickCountBefore, registryStickCountAfter, registrySentinelAfter,
    })}`);
  }

  const {
    runInventorySmoke,
    runDeathRespawnSmoke,
    runMenuSmoke,
    runCraftSmoke,
    runEyeSmoke,
  } = createRuntimeSdkToolScenarios({
    runtime,
    client,
    url,
    actor,
    selfStatus,
    bodyPosition,
    bodyX,
    bodyY,
    bodyZ,
    expectedWorldKnowledgeProfile,
    matchingItemCount,
    runtimeCommand,
    assertBodyNear,
    waitForBodyOnGround,
    activateBlockAfterSettling,
    runSmeltAtFurnaceSmoke,
  });

  if (process.env.EVICRAFT_SMOKE_SCOPE === "inventory") {
    await runInventorySmoke();
    await runDeathRespawnSmoke(client);
    client.close();
    console.log(JSON.stringify({
      status: "passed",
      scope: "inventory",
      endpoint: url,
      protocolVersion: info.protocol_version,
      actorUuid: actor.uuid,
      checks: [
        "tool catalogue", "equip_item Inventory conservation",
        "equip_item overflow exact drop attribution",
        "eat vanilla duration and Inventory delta", "Inventory Tool busy",
        "eat cancellation and native input cleanup",
        "drop_items exact quantity and attributable Entity Track UUID",
        "same-type preexisting item is not attributed",
        "active TaskResult death termination and same-World-Run respawn",
      ],
    }, null, 2));
  } else if (process.env.EVICRAFT_SMOKE_SCOPE === "menu") {
    await runMenuSmoke();
    client.close();
    console.log(JSON.stringify({
      status: "passed",
      scope: "menu",
      endpoint: url,
      protocolVersion: info.protocol_version,
      actorUuid: actor.uuid,
      checks: [
        "unopened storage is not inspected", "visible Menu slots and canonical items",
        "exact deposit", "routed withdrawal", "quantity and slot validation",
        "close_gui verified terminal", "no-Menu transfer failure",
        "inspect_block_storage remains unavailable",
      ],
    }, null, 2));
  } else if (process.env.EVICRAFT_SMOKE_SCOPE === "craft") {
    await runCraftSmoke();
    client.close();
    console.log(JSON.stringify({
      status: "passed",
      scope: "craft",
      endpoint: url,
      protocolVersion: info.protocol_version,
      actorUuid: actor.uuid,
      checks: [
        "bounded full-match recipe/output Canonical ID Glob", "unsupported Glob syntax rejection",
        "direct 2x2 vanilla craft and Inventory delta",
        "unopened 3x3 Menu gate", "evidence-bound canonical crafting-table open",
        "3x3 vanilla craft and Inventory delta", "failed recipe TaskResult",
      ],
    }, null, 2));
  } else if (process.env.EVICRAFT_SMOKE_SCOPE === "eye") {
    await runEyeSmoke();
    client.close();
    console.log(JSON.stringify({
      status: "passed",
      scope: "eye",
      endpoint: url,
      protocolVersion: info.protocol_version,
      actorUuid: actor.uuid,
      checks: [
        "no-Menu and Inventory preconditions", "one native consumption",
        "selected-slot restoration", "five-tick normalized 3D direction",
        "exact dropped ItemEntity UUID and Track", "shattered without false Track",
        "forbidden locator fields absent", "ordinary canceled TaskResult",
      ],
    }, null, 2));
  } else if (process.env.EVICRAFT_SMOKE_SCOPE === "search") {
    await runRealHarnessExplorationSmoke(runtime, client, url, bodyPosition);
    client.close();
    console.log(JSON.stringify({
      status: "passed",
      scope: "search",
      endpoint: url,
      protocolVersion: info.protocol_version,
      actorUuid: actor.uuid,
      checks: [
        "initial remembered evidence does not contain the hidden target",
        "unique supported corridor constrains every goto to OPEN-only exploration",
        "explore_and_return succeeds and returns to the exact start Feet Cell",
        "find_known_blocks returns the exact discovered target after the excursion",
        "fixture target and Runtime Bot position are restored during cleanup",
      ],
    }, null, 2));
  } else {
  const blockEvidence = await client.blockGet(selfStatus.data.dimension, [
    { x: bodyX, y: bodyY + 1, z: bodyZ },
    { x: bodyX, y: bodyY - 1, z: bodyZ },
    { x: bodyX + 1, y: bodyY - 1, z: bodyZ },
    { x: bodyX - 1, y: bodyY - 1, z: bodyZ },
    { x: bodyX, y: bodyY - 1, z: bodyZ + 1 },
    { x: bodyX, y: bodyY - 1, z: bodyZ - 1 },
    { x: bodyX + 1_000_000, y: bodyY, z: bodyZ },
  ]);
  const support = blockEvidence.cells[1];
  if (blockEvidence.operation !== "block.get"
      || blockEvidence.cells[0]?.state === "UNKNOWN"
      || support?.state !== "KNOWN_BLOCK"
      || blockEvidence.cells[6]?.state !== "UNKNOWN") {
    throw new Error(`unexpected block.get evidence: ${JSON.stringify(blockEvidence)}`);
  }
  for (const cell of [blockEvidence.cells[0], support]) {
    if (typeof cell.source !== "string"
        || !Number.isInteger(cell.observed_tick)
        || !Number.isInteger(cell.observation_revision)) {
      throw new Error(`known cell omitted provenance: ${JSON.stringify(cell)}`);
    }
  }
  const knownBlocks = await client.blockFind(selfStatus.data.dimension, "*");
  if (knownBlocks.operation !== "block.find"
      || knownBlocks.matches.length < 1
      || knownBlocks.matches.length > 256
      || knownBlocks.complete !== false
      || typeof knownBlocks.has_more !== "boolean"
      || knownBlocks.matches.some((cell) => cell.state !== "KNOWN_BLOCK")) {
    throw new Error(`unexpected block.find known-only result: ${JSON.stringify(knownBlocks)}`);
  }
  const nearestKnownBlock = await client.blockFind(selfStatus.data.dimension, "*", {
    origin: { x: bodyX, y: bodyY, z: bodyZ },
    limit: 1,
  });
  if (nearestKnownBlock.matches.length !== 1
      || nearestKnownBlock.matches[0]?.state !== "KNOWN_BLOCK"
      || nearestKnownBlock.complete !== false
      || typeof nearestKnownBlock.has_more !== "boolean") {
    throw new Error(`block.find origin/limit selection failed: ${JSON.stringify(nearestKnownBlock)}`);
  }
  const globKnownBlocks = await client.blockFind(selfStatus.data.dimension, "minecraft:*");
  if (globKnownBlocks.matches.length < 1
      || globKnownBlocks.matches.some((cell) => !cell.block_state.startsWith("minecraft:"))) {
    throw new Error(`block.find Glob selection failed: ${JSON.stringify(globKnownBlocks)}`);
  }
  const emptyFind = await client.blockFind(
    selfStatus.data.dimension, "minecraft:identifier_that_does_not_exist");
  if (emptyFind.matches.length !== 0 || emptyFind.complete !== false) {
    throw new Error(`empty block.find claimed absence: ${JSON.stringify(emptyFind)}`);
  }
  await client.blockFind(selfStatus.data.dimension, "minecraft:(stone)")
    .then(() => { throw new Error("block.find accepted unsupported Glob syntax"); }, (error) => {
      if (!String(error).includes("-32602")) throw error;
    });

  const knownCell = blockEvidence.cells[0];
  const knownRegion = await client.blockRegion(
    selfStatus.data.dimension, knownCell.position, knownCell.position);
  const knownPaletteEntry = knownRegion.palette[knownRegion.indices[0]];
  if (!knownRegion.complete || knownRegion.indices.length !== 1
      || !knownPaletteEntry || knownPaletteEntry.state === "UNKNOWN") {
    throw new Error(`known block.region was not complete: ${JSON.stringify(knownRegion)}`);
  }
  const remote = { x: bodyX + 1_000_000, y: bodyY, z: bodyZ };
  const unknownRegion = await client.blockRegion(selfStatus.data.dimension, remote, remote);
  const unknownPaletteEntry = unknownRegion.palette[unknownRegion.indices[0]];
  if (unknownRegion.complete || unknownRegion.indices.length !== 1
      || unknownPaletteEntry?.state !== "UNKNOWN") {
    throw new Error(`remote block.region did not preserve UNKNOWN: ${JSON.stringify(unknownRegion)}`);
  }
  await client.blockRegion(selfStatus.data.dimension,
    { x: 0, y: 0, z: 0 }, { x: 128, y: 0, z: 0 })
    .then(() => { throw new Error("block.region accepted a 129-cell axis"); }, (error) => {
      if (!String(error).includes("-32602")) throw error;
    });

  if (typeof actor.uuid !== "string") {
    throw new Error(`alive actor omitted UUID: ${JSON.stringify(actor)}`);
  }
  const actorTrack = await client.entityGet(actor.uuid);
  if (actorTrack.operation !== "entity.get" || actorTrack.track !== null) {
    throw new Error(`entity.get treated the Runtime Bot as an external target: ${JSON.stringify(actorTrack)}`);
  }
  const knownEntities = await client.entityList({
    dimension: selfStatus.data.dimension,
    entityIdGlob: "*",
  });
  if (knownEntities.operation !== "entity.list"
      || knownEntities.tracks.length > 256
      || typeof knownEntities.has_more !== "boolean"
      || knownEntities.tracks.some((track) => typeof track.uuid !== "string"
        || !["VISIBLE", "KNOWN"].includes(track.state)
        || "id" in track || "entity_numeric_id" in track
        || "health" in track || "max_health" in track)) {
    throw new Error(`unexpected bounded Entity Tracks: ${JSON.stringify(knownEntities)}`);
  }
  const globEntities = await client.entityList({ entityIdGlob: "minecraft:*" });
  if (globEntities.tracks.some((track) => !track.entity_id.startsWith("minecraft:"))) {
    throw new Error(`entity.list Glob selection failed: ${JSON.stringify(globEntities)}`);
  }
  const emptyEntities = await client.entityList({
    entityIdGlob: "minecraft:identifier_that_does_not_exist",
  });
  if (emptyEntities.tracks.length !== 0) {
    throw new Error(`entity.list returned a nonmatching canonical id: ${JSON.stringify(emptyEntities)}`);
  }
  await client.entityList({ entityIdGlob: "minecraft:(item)" })
    .then(() => { throw new Error("entity.list accepted unsupported Glob syntax"); }, (error) => {
      if (!String(error).includes("-32602")) throw error;
    });
  const interactEntityDescriptor = catalogue.tools.find(
    (tool) => tool.name === "interact_entity");
  const interactEntityProperties = interactEntityDescriptor?.parameters?.properties ?? {};
  if (JSON.stringify(Object.keys(interactEntityProperties))
        !== JSON.stringify(["uuid", "hold_ticks", "item_id"])
      || JSON.stringify(interactEntityDescriptor?.parameters?.required)
        !== JSON.stringify(["uuid", "hold_ticks", "item_id"])) {
    throw new Error(`interact_entity exposed a numeric id, selector, or attack mode: ${JSON.stringify(interactEntityDescriptor)}`);
  }
  const collectItemsDescriptor = catalogue.tools.find(
    (tool) => tool.name === "collect_items");
  const collectProperties = collectItemsDescriptor?.parameters?.properties ?? {};
  if (JSON.stringify(Object.keys(collectProperties))
        !== JSON.stringify(["uuids", "item_id_glob", "radius"])
      || JSON.stringify(collectItemsDescriptor?.parameters?.required)
        !== JSON.stringify(["uuids", "radius"])
      || collectProperties.uuids?.minItems !== 1
      || collectProperties.uuids?.maxItems !== 64
      || collectProperties.radius?.minimum !== 1
      || collectProperties.radius?.maximum !== 48
      || !collectProperties.radius?.description?.includes("default 8")) {
    throw new Error(`collect_items did not expose bounded UUID/Glob selection with default radius 8: ${JSON.stringify(collectItemsDescriptor)}`);
  }
  const attackDescriptor = catalogue.tools.find((tool) => tool.name === "attack");
  const attackProperties = attackDescriptor?.parameters?.properties ?? {};
  if (JSON.stringify(Object.keys(attackProperties)) !== JSON.stringify(["uuids"])
      || JSON.stringify(attackDescriptor?.parameters?.required) !== JSON.stringify(["uuids"])
      || JSON.stringify(attackProperties.uuids?.type) !== JSON.stringify(["array", "null"])
      || attackProperties.uuids?.minItems !== 1
      || attackProperties.uuids?.maxItems !== 20) {
    throw new Error(`attack did not expose bounded UUID selection: ${JSON.stringify(attackDescriptor)}`);
  }
  const unknownAttack = await client.toolCall("attack", { uuids: [randomUUID()] });
  if (unknownAttack.success || unknownAttack.data?.failure_type !== "target_lost") {
    throw new Error(`unknown attack UUID did not return target_lost: ${JSON.stringify(unknownAttack)}`);
  }
  const unknownEntityInteraction = await client.toolCall("interact_entity", {
    uuid: randomUUID(),
  });
  if (unknownEntityInteraction.success
      || unknownEntityInteraction.data?.failure_type !== "target_lost") {
    throw new Error(`unknown UUID did not return target_lost: ${JSON.stringify(unknownEntityInteraction)}`);
  }
  const numericEntityInteraction = await client.toolCall("interact_entity", {
    entity_id: 1,
  });
  if (numericEntityInteraction.success
      || !numericEntityInteraction.message.includes("uuid")) {
    throw new Error(`numeric entity id reached interact_entity: ${JSON.stringify(numericEntityInteraction)}`);
  }
  const attackEntityInteraction = await client.toolCall("interact_entity", {
    uuid: randomUUID(),
    button: "left",
  });
  if (attackEntityInteraction.success) {
    throw new Error(`interact_entity exposed attack mode: ${JSON.stringify(attackEntityInteraction)}`);
  }
  const worldStatus = await client.toolCall("get_world_info", {});
  const worldKeys = Object.keys(worldStatus.data ?? {}).sort();
  if (!worldStatus.success || JSON.stringify(worldKeys) !== JSON.stringify([
    "difficulty", "time_of_day",
  ])) {
    throw new Error(`unexpected get_world_info: ${JSON.stringify(worldStatus)}`);
  }
  for (const forbidden of ["seed", "game_time", "tick", "locator", "structures", "structure_membership"]) {
    if (forbidden in worldStatus.data) {
      throw new Error(`get_world_info exposed forbidden field ${forbidden}`);
    }
  }
  const unknownTool = await client.toolCall("locate_structure", {});
  if (unknownTool.success || unknownTool.failure_type !== "unknown_tool") {
    throw new Error(`unknown Tool did not return stable failure: ${JSON.stringify(unknownTool)}`);
  }

  const unknownGlobGoto = await client.toolCall("goto", {
    goal: { kind: "block", block_id_glob: "minecraft:identifier_that_does_not_exist*" },
  });
  if (unknownGlobGoto.success || !unknownGlobGoto.message.includes("unknown/not-known")) {
    throw new Error(`goto block_id_glob discovered or proved an unknown target: ${JSON.stringify(unknownGlobGoto)}`);
  }

  console.log("smoke: evidence-bound use_item, activate_block and break_block");
  // Bot Resolution intentionally preserves an existing Bot's Inventory in the
  // persistent smoke World Run. This scenario requires an empty hand so a
  // retained food or use-item stack cannot turn the generic interaction into
  // a different, correctly rejected action.
  await runtimeCommand(runtime, "clear bot");
  const unknownInteract = await client.toolCall("use_item", { aim: remote });
  if (unknownInteract.success || unknownInteract.failure_type !== "aim_not_known_air") {
    throw new Error(`use_item accepted an UNKNOWN aim: ${JSON.stringify(unknownInteract)}`);
  }
  let exactAim;
  const attemptedAims = new Set();
  const interactionAttempts = [];
  for (let round = 0; round < 2 && !exactAim; round += 1) {
    const nearby = await client.blockRegion(selfStatus.data.dimension,
      { x: bodyX - 4, y: bodyY - 4, z: bodyZ - 4 },
      { x: bodyX + 4, y: bodyY + 4, z: bodyZ + 4 });
    const nearbyKnown = [];
    for (let index = 0; index < nearby.indices.length; index += 1) {
      const cell = nearby.palette[nearby.indices[index]];
      if (cell?.state !== "KNOWN_BLOCK") continue;
      const dx = index % nearby.size.x;
      const dy = Math.floor(index / nearby.size.x) % nearby.size.y;
      const dz = Math.floor(index / (nearby.size.x * nearby.size.y));
      nearbyKnown.push({
        position: {
          x: nearby.min.x + dx,
          y: nearby.min.y + dy,
          z: nearby.min.z + dz,
        },
      });
    }
    const reachableKnown = nearbyKnown
      .filter((cell) => Math.hypot(
        cell.position.x + 0.5 - bodyPosition.x,
        cell.position.y + 0.5 - bodyPosition.y,
        cell.position.z + 0.5 - bodyPosition.z,
      ) <= 4.5)
      .sort((left, right) => {
        const leftDistance = Math.hypot(
          left.position.x + 0.5 - bodyPosition.x,
          left.position.y + 0.5 - bodyPosition.y,
          left.position.z + 0.5 - bodyPosition.z,
        );
        const rightDistance = Math.hypot(
          right.position.x + 0.5 - bodyPosition.x,
          right.position.y + 0.5 - bodyPosition.y,
          right.position.z + 0.5 - bodyPosition.z,
        );
        return leftDistance - rightDistance;
      });
    for (const candidate of reachableKnown) {
      const key = `${candidate.position.x},${candidate.position.y},${candidate.position.z}`;
      if (attemptedAims.has(key)) continue;
      attemptedAims.add(key);
      const result = await client.toolCall("activate_block", { position: candidate.position });
      interactionAttempts.push({ aim: candidate.position, result });
      if (!result.success && result.failure_type === "no_effect") {
        exactAim = candidate.position;
        break;
      }
    }
  }
  if (!exactAim) {
    throw new Error(`could not establish a reachable exact no-effect target: ${JSON.stringify(interactionAttempts)}`);
  }
  const noEffectEvidence = await client.blockGet(selfStatus.data.dimension, [exactAim]);
  // A post-step observation may supersede the immediate PVA publication before
  // this RPC read. Publication provenance is tested at the World Knowledge seam.
  if (noEffectEvidence.cells[0]?.state !== "KNOWN_BLOCK") {
    throw new Error(`right no-effect did not retain known target evidence: ${JSON.stringify(noEffectEvidence)}`);
  }
  const exactLeft = await client.toolCall("break_block", { position: exactAim });
  if (!exactLeft.success) {
    throw new Error(`exact break_block failed: ${JSON.stringify(exactLeft)}`);
  }
  const brokenEvidence = await client.blockGet(selfStatus.data.dimension, [exactAim]);
  if (brokenEvidence.cells[0]?.state !== "KNOWN_AIR") {
    throw new Error(`exact left did not publish KNOWN_AIR: ${JSON.stringify(brokenEvidence)}`);
  }
  await runExactBreakOcclusionSmoke(
    runtime, client, selfStatus.data.dimension, harnessAbilities,
  );

  await runEntityCollectionCombatSmoke({
    client,
    dimension: selfStatus.data.dimension,
    bodyPosition,
    bodyX,
    bodyY,
    bodyZ,
    command: (commandText) => runtimeCommand(runtime, commandText),
    assertBodyNear,
    matchingItemCount: (player, itemId) => matchingItemCount(runtime, player, itemId),
  });

  await runInventorySmoke();
  await runMenuSmoke();
  await runCraftSmoke();
  await runEyeSmoke();
  await runRealHarnessNativeSurfaceSmoke(client, url);
  await runRealHarnessExplorationSmoke(runtime, client, url, bodyPosition);

  console.log("smoke: goto busy and cancel");
  const runningGoto = client.startToolCall("goto", { goal: { kind: "column", x: bodyX + 80, z: bodyZ } });
  await delay(100);
  const busyGoto = await client.toolCall("goto", { goal: { kind: "elevation", y: bodyY + 20 } });
  if (busyGoto.success || busyGoto.failure_type !== "busy") {
    throw new Error(`concurrent body Tool was not busy: ${JSON.stringify(busyGoto)}`);
  }
  const cancelled = await client.taskCancel(runningGoto.taskId);
  if (!cancelled.cancelled || cancelled.task_id !== runningGoto.taskId) {
    throw new Error(`task.cancel did not address the request id: ${JSON.stringify(cancelled)}`);
  }
  const cancelledResult = await runningGoto.result;
  if (cancelledResult.success || cancelledResult.interrupted !== true) {
    throw new Error(`cancelled goto did not return its terminal result: ${JSON.stringify(cancelledResult)}`);
  }

  console.log("smoke: wrong token");
  if (await rejectedStatus(url, "wrong-token") !== 401) throw new Error("wrong token was not HTTP 401");
  console.log("smoke: missing authorization");
  if (await rejectedStatus(url, undefined) !== 401) throw new Error("missing authorization was not HTTP 401");
  console.log("smoke: second controller");
  const secondController = await rejectedStatus(url, token);
  if (secondController !== 409 && secondController !== "reset") {
    throw new Error(`second controller was not rejected: ${secondController}`);
  }

  console.log("smoke: controller release");
  const reconnectKnowledgeBefore = await client.blockGet(
    selfStatus.data.dimension, [breakTarget]);
  const disconnectedGoto = client.startToolCall("goto", { goal: { kind: "column", x: bodyX - 80, z: bodyZ } });
  disconnectedGoto.result.catch(() => {});
  stopOccurrences();
  client.close();
  await delay(1_000);
  const replacement = await RuntimeClient.connect({ url, bearerToken: token });
  await replacement.runtimeInfo();
  const replacementActor = await replacement.actorGet();
  const reconnectKnowledgeAfter = await replacement.blockGet(
    selfStatus.data.dimension, [breakTarget]);
  const reconnectFact = (cell) => ({
    state: cell?.state,
    block_state: cell?.block_state,
    fluid: cell?.fluid,
    source: cell?.source,
  });
  if (replacementActor?.uuid !== actor.uuid
      || JSON.stringify(reconnectFact(reconnectKnowledgeAfter.cells[0]))
        !== JSON.stringify(reconnectFact(reconnectKnowledgeBefore.cells[0]))) {
    throw new Error(`SDK reconnect replaced World Run knowledge: ${JSON.stringify({
      actor, replacementActor, reconnectKnowledgeBefore, reconnectKnowledgeAfter,
    })}`);
  }
  const stoppedBefore = await replacement.toolCall("get_self_status", {});
  await delay(500);
  const stoppedAfter = await replacement.toolCall("get_self_status", {});
  const beforePosition = stoppedBefore.data?.position;
  const afterPosition = stoppedAfter.data?.position;
  const cleanupDrift = beforePosition && afterPosition
    ? Math.hypot(
      afterPosition.x - beforePosition.x,
      afterPosition.y - beforePosition.y,
      afterPosition.z - beforePosition.z,
    )
    : Number.POSITIVE_INFINITY;
  if (cleanupDrift > 0.25) {
    throw new Error(`disconnect did not halt body input: ${JSON.stringify({
      beforePosition, afterPosition, cleanupDrift,
    })}`);
  }
  const replacementGoto = replacement.startToolCall("goto", {
    goal: { kind: "column", x: bodyX + 80, z: bodyZ + 80 },
  });
  await delay(100);
  const replacementCancel = await replacement.taskCancel(replacementGoto.taskId);
  if (!replacementCancel.cancelled) {
    throw new Error(`disconnect left a stale task or replacement cancel failed: ${JSON.stringify(replacementCancel)}`);
  }
  const replacementResult = await replacementGoto.result;
  if (replacementResult.interrupted !== true) {
    throw new Error(`replacement task did not own its terminal result: ${JSON.stringify(replacementResult)}`);
  }
  await runDeathRespawnSmoke(replacement);
  // Vanilla respawn grants a short damage-immunity window. Let it expire so
  // the following /damage command deterministically produces damage_received.
  await delay(3_500);
  await runRealHarnessOccurrenceSmoke(runtime, replacement, url);
  await runRealHarnessLowAirSurfaceSmoke(runtime, replacement, url);

  console.log(JSON.stringify({
    status: "passed",
    endpoint: url,
    protocolVersion: info.protocol_version,
    actorUuid: actor.uuid,
    checks: [
      "missing endpoint token", "port override", "correct token", "wrong token",
      "missing authorization", "single controller", "observation refresh", "block.get evidence",
      "separate Authority disabled state, tokens, coexistence, post-tick block receipt, actor projection, teleport, and listener release",
      "bounded Glob block.find", "origin/limit block.find selection",
      "palette block.region", "selector and region bounds",
      "UUID entity.get", "bounded Glob entity.list", "knowledge-bound interact_entity",
      "VISIBLE UUID native interaction", "KNOWN freeze and VISIBLE reacquisition",
      "UUID item collection", "Glob knowledge-bound collection", "collection radius",
      "collection no-live-scan",
      "VISIBLE UUID attack", "KNOWN attack freeze and reacquisition",
      "explicit multi-target attack", "omitted visible hostile and split admission",
      "far VISIBLE explicit UUID", "ranged death attribution", "non-living explosive spacing",
      "Actor-attributed combat drops and pickup", "omitted attack no-live-discovery",
      "equip_item Inventory delta", "eat vanilla duration/busy/cancel",
      "drop_items exact quantity and Entity Track attribution",
      "Menu inspect/transfer/close and no-storage-scan",
      "immediately consumed furnace fuel receipt and rejected-fuel accounting",
      "live smelt_at_furnace existing/caller fuel, processing, output collection, and closure",
      "recipe Glob and 2x2/3x3 crafting Menu gate",
      "embodied Ender Eye direction/terminal/cancellation",
    "verified activate_block Menu and hand restoration",
    "verified use_item_on_block effect, durability, and hand restoration",
      "verified place_block state, consumption, and body restoration",
      "live mine_down embodied start, staircase clearance, and explicit down",
      "live tunnel_for_blocks embodied start, verified step, and Tunnel Frontier target",
      "live collect_blocks current-nearest requery, verified breaks, and observed-drop collection",
      "Harness final block intents, distance sleep_in_bed, and raw break_block SDK-only retention",
      "tool catalogue", "status Tools", "forbidden fields",
      "goto Glob unknown target", "use_item UNKNOWN rejection", "activate_block no-effect",
      "Agent-facing break_block Pose-local occluding block", "goto busy", "task.cancel", "disconnect input cleanup",
      "active TaskResult death termination and same-World-Run respawn",
      "live final Native Mode Ability and Control Tool surface",
      "World Run Scaffold Material policy and Decision Request navigation_policy",
      "live Harness unique-corridor Exploration Excursion and exact later remembered-block query",
      "live final Code Mode Control Tool surface, Skill load, and Plan replacement",
      "live Runtime Occurrence Harness preemption and fresh Turn",
      "live low-air surface Instinct and breathable fresh Turn",
    ],
  }, null, 2));
  }
  }

}
