import { runScenarioHarness as runHarness } from "./test-context.mjs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AbilityRuntime } from "../../../dist/harness/ability-runtime.js";
import { abilities } from "../../../dist/harness/abilities/index.js";
import { borrowedRuntimeSession, staticGoalContext } from "../../../dist/harness/run-harness.js";
import { RuntimeAdapter } from "../../../dist/harness/runtime-adapter.js";
import {
  sameBlockPosition,
  scriptedSmokeModel,
  scriptedScenarioEnd, scriptedToolDecision,
  smokeModelConfig,
} from "./test-context.mjs";

export function createOcclusionAndReselectionScenarios({
  runtimeCommand,
  assertBodyNear,
  matchingItemCount,
}) {
async function withOccludingBreakFixture(
  runtime, client, dimension, verify, {
    targetBlock = "stone", targetOffset = 3, additionalLeafOffsets = [],
  } = {},
) {
  const status = await client.toolCall("get_self_status", {});
  const position = status.data?.position;
  if (!status.success || !position || ![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new Error(`occluding-break fixture lacked a current body position: ${JSON.stringify(status)}`);
  }
  const origin = {
    x: Math.floor(position.x) + 12,
    y: 240,
    z: Math.floor(position.z) + 12,
  };
  const target = { x: origin.x + targetOffset, y: origin.y + 1, z: origin.z };
  const blocker = { x: origin.x + targetOffset - 1, y: origin.y + 1, z: origin.z };
  const leafDistance = targetBlock === "oak_log" ? 1 : 7;
  const expectedBlockState = `minecraft:oak_leaves[distance=${leafDistance},persistent=true,waterlogged=false]`;
  try {
    await runtimeCommand(runtime,
      `fill ${origin.x - 3} ${origin.y - 1} ${origin.z - 3} ${origin.x + 6} ${origin.y + 3} ${origin.z + 3} air`);
    await runtimeCommand(runtime,
      `fill ${origin.x - 3} ${origin.y - 1} ${origin.z - 3} ${origin.x + 6} ${origin.y - 1} ${origin.z + 3} stone`);
    await runtimeCommand(runtime, `setblock ${target.x} ${target.y} ${target.z} ${targetBlock}`);
    await runtimeCommand(runtime, `tp bot ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5} -90 0`);
    await assertBodyNear(client,
      { x: origin.x + 0.5, y: origin.y, z: origin.z + 0.5 }, "occluding-break fixture start", 0.75);
    let targetEvidence;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await client.observe();
      targetEvidence = await client.blockGet(dimension, [target]);
      if (targetEvidence.cells[0]?.state === "KNOWN_BLOCK") break;
      await delay(50);
    }
    if (targetEvidence?.cells[0]?.state !== "KNOWN_BLOCK") {
      throw new Error(`occluded target was not known before the blocker appeared: ${JSON.stringify(targetEvidence)}`);
    }
    await runtimeCommand(runtime,
      `setblock ${blocker.x} ${blocker.y} ${blocker.z} minecraft:oak_leaves[distance=${leafDistance},persistent=true]`);
    for (const { y, z } of additionalLeafOffsets) {
      await runtimeCommand(runtime,
        `setblock ${blocker.x} ${blocker.y + y} ${blocker.z + z} minecraft:oak_leaves[distance=${leafDistance},persistent=true]`);
    }
    await verify({ target, blocker, expectedBlockState });
  } finally {
    await runtimeCommand(runtime,
      `fill ${origin.x - 3} ${origin.y - 1} ${origin.z - 3} ${origin.x + 6} ${origin.y + 3} ${origin.z + 3} air`).catch(() => {});
  }
}

async function runExactBreakOcclusionSmoke(
  runtime, client, dimension, harnessAbilities,
) {
  console.log("smoke: exact break Pose-local occluding block and later evidence-bound break");
  await withOccludingBreakFixture(runtime, client, dimension, async ({
    target, blocker, expectedBlockState,
  }) => {
    const blocked = await harnessAbilities.dispatch("break_block", {
      position: target,
    }, {
      runtime: new RuntimeAdapter(client),
    });
    const blockedData = blocked.data;
    const observedBlocker = blockedData?.occluding_block;
    if (blocked.ok || blockedData?.failure_type !== "occluded"
        || !sameBlockPosition(blockedData.position, target)
        || !sameBlockPosition(observedBlocker?.position, blocker)
        || observedBlocker?.block_state !== expectedBlockState) {
      throw new Error(`exact break did not return the native Pose-local leaves blocker: ${JSON.stringify(blocked)}`);
    }
    const admitted = await client.blockGet(dimension, [blocker]);
    if (admitted.cells[0]?.state !== "KNOWN_BLOCK"
        || admitted.cells[0]?.block_state !== expectedBlockState) {
      throw new Error(`returned leaves blocker was not admitted before the next exact break: ${JSON.stringify(admitted)}`);
    }

    const blockerBreak = await harnessAbilities.dispatch("break_block", {
      position: blocker,
    }, {
      runtime: new RuntimeAdapter(client),
    });
    const targetStillPresent = await runtimeCommand(runtime,
      `execute if block ${target.x} ${target.y} ${target.z} stone`);
    if (!blockerBreak.ok
        || !sameBlockPosition(blockerBreak.data?.position, blocker)
        || !targetStillPresent.includes("Test passed")) {
      throw new Error(`later exact break did not remove only the admitted blocker: ${JSON.stringify({
        blockerBreak, targetStillPresent,
      })}`);
    }
  });
}

async function runGotoAndBreakOccludingSmoke(runtime, client, dimension, fixtureOptions = undefined) {
  console.log("smoke: goto_and_break_block clears an exact foliage Occluding Block before its frozen target");
  const calls = [];
  const breakResults = [];
  const abilityRuntime = new AbilityRuntime({
    onEvent(event) {
      if (event.type === "ability_call_started") calls.push(event.ability);
      if (event.type === "ability_call_finished" && event.ability === "break_block") {
        breakResults.push(event.result);
      }
    },
  });
  for (const definition of abilities) await abilityRuntime.register(definition);
  await withOccludingBreakFixture(runtime, client, dimension, async ({
    target, blocker, expectedBlockState,
  }) => {
    const result = await abilityRuntime.dispatch("goto_and_break_block", { position: target }, {
      runtime: new RuntimeAdapter(client),
    });
    const targetAir = await runtimeCommand(runtime,
      `execute if block ${target.x} ${target.y} ${target.z} air`);
    const blockerAir = await runtimeCommand(runtime,
      `execute if block ${blocker.x} ${blocker.y} ${blocker.z} air`);
    const clearing = result.data?.cleared_occluding_blocks?.[0];
    if (!result.ok
        || JSON.stringify(Object.keys(result.data ?? {})) !== JSON.stringify([
          "position", "observed_drop_entities", "cleared_occluding_blocks",
        ])
        || !sameBlockPosition(result.data?.position, target)
        || !Array.isArray(result.data?.observed_drop_entities)
        || result.data.cleared_occluding_blocks?.length !== 1
        || !sameBlockPosition(clearing?.position, blocker)
        || clearing?.block_state !== expectedBlockState
        || !Array.isArray(clearing?.observed_drop_entities)
        || calls.filter((ability) => ability === "break_block").length !== 3
        || calls.includes("goto_block_interaction_pose")
        || !targetAir.includes("Test passed")
        || !blockerAir.includes("Test passed")) {
      throw new Error(`goto_and_break_block did not clear foliage then remove its frozen target: ${JSON.stringify({
        result, calls, breakResults, targetAir, blockerAir,
      })}`);
    }
  }, fixtureOptions);
}

async function runFoliageCollectionSmoke(runtime, client, dimension) {
  console.log("smoke: collect_blocks reconciles oak_log and oak_leaves UUID drops in one foliage fixture");
  const collectCalls = [];
  const breakReceipts = [];
  const abilityRuntime = new AbilityRuntime({
    onEvent(event) {
      if (event.type === "ability_call_started" && event.ability === "collect_items") {
        collectCalls.push(event.input);
      }
      if (event.type === "ability_call_finished" && event.ability === "goto_and_break_block") {
        breakReceipts.push(event.result);
      }
    },
  });
  for (const definition of abilities) await abilityRuntime.register(definition);
  try {
    await runtimeCommand(runtime, "gamemode survival bot");
    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, "item replace entity bot weapon.mainhand with minecraft:shears 1");
    await withOccludingBreakFixture(runtime, client, dimension, async ({ target, blocker, expectedBlockState }) => {
      const result = await abilityRuntime.dispatch("collect_blocks", { positions: [target] }, {
        runtime: new RuntimeAdapter(client),
      });
      const targetAir = await runtimeCommand(runtime,
        `execute if block ${target.x} ${target.y} ${target.z} air`);
      const blockerAir = await runtimeCommand(runtime,
        `execute if block ${blocker.x} ${blocker.y} ${blocker.z} air`);
      const leaves = await matchingItemCount(runtime, "bot", "minecraft:oak_leaves");
      const logs = await matchingItemCount(runtime, "bot", "minecraft:oak_log");
      const receipt = breakReceipts.find((candidate) => candidate?.ok === true);
      const clearing = receipt?.data?.cleared_occluding_blocks?.[0];
      const leafDrop = clearing?.observed_drop_entities?.[0];
      const logDrop = receipt?.data?.observed_drop_entities?.[0];
      if (!result.ok
          || result.data?.completed_blocks !== 1
          || result.data?.broken_blocks !== 1
          || result.data?.completed_positions?.length !== 1
          || !sameBlockPosition(result.data.completed_positions[0], target)
          || result.data?.collected_items?.["minecraft:oak_leaves"] !== 1
          || result.data?.collected_items?.["minecraft:oak_log"] !== 1
          || result.data?.unresolved_observed_drops?.length !== 0
          || !sameBlockPosition(receipt?.data?.position, target)
          || !sameBlockPosition(clearing?.position, blocker)
          || clearing?.block_state !== expectedBlockState
          || leafDrop?.item_id !== "minecraft:oak_leaves" || leafDrop?.count !== 1
          || logDrop?.item_id !== "minecraft:oak_log" || logDrop?.count !== 1
          || collectCalls.length !== 2
          || collectCalls.some((input) => !Array.isArray(input?.uuids) || input.uuids.length !== 1)
          || JSON.stringify(collectCalls.map((input) => input.uuids[0]).sort())
            !== JSON.stringify([leafDrop?.uuid, logDrop?.uuid].sort())
          || !targetAir.includes("Test passed") || !blockerAir.includes("Test passed")
          || leaves !== 1 || logs !== 1) {
        throw new Error(`collect_blocks did not reconcile the known foliage fixture by exact UUID: ${JSON.stringify({
          result, collectCalls, target, blocker, expectedBlockState, targetAir, blockerAir, leaves, logs,
        })}`);
      }
      console.log(JSON.stringify({
        smoke: "oak_log_oak_leaves_drop_reconciliation",
        target, blocker, leafDrop, logDrop, collectCalls,
      }));
    }, {
      targetBlock: "oak_log",
    });
  } finally {
    await runtimeCommand(runtime, "gamemode creative bot").catch(() => {});
    await runtimeCommand(runtime, "clear bot").catch(() => {});
  }
}

async function prepareInteractionPoseFixture(runtime, client, dimension, blockId, label) {
  const status = await client.toolCall("get_self_status", {});
  const position = status.data?.position;
  if (!status.success || !position || ![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new Error(`${label} fixture lacked a current body position: ${JSON.stringify(status)}`);
  }
  const start = { x: Math.floor(position.x) + 32, y: 240, z: Math.floor(position.z) + 16 };
  const target = { x: start.x + 7, y: start.y + 1, z: start.z };
  const seedX = target.x - 2;
  const midX = Math.floor((start.x + seedX) / 2);
  const route = [];
  for (let x = start.x; x <= seedX; x += 1) {
    route.push(
      { x, y: start.y - 1, z: start.z },
      { x, y: start.y, z: start.z },
      { x, y: start.y + 1, z: start.z },
    );
  }
  await runtimeCommand(runtime,
    `fill ${start.x - 2} ${start.y - 1} ${start.z - 3} ${target.x + 2} ${start.y + 2} ${start.z + 3} air`);
  await runtimeCommand(runtime,
    `fill ${start.x - 2} ${start.y - 1} ${start.z - 3} ${target.x + 2} ${start.y - 1} ${start.z + 3} stone`);
  await runtimeCommand(runtime, `setblock ${target.x} ${target.y} ${target.z} ${blockId}`);
  for (const x of [midX, seedX]) {
    await runtimeCommand(runtime,
      `tp bot ${x + 0.5} ${start.y} ${start.z + 0.5} facing ${target.x + 0.5} ${target.y + 0.5} ${target.z + 0.5}`);
    await assertBodyNear(client, { x: x + 0.5, y: start.y, z: start.z + 0.5 }, `${label} evidence seed`);
    await client.observe();
  }
  let evidence;
  const evidenceDeadline = Date.now() + 15_000;
  while (Date.now() < evidenceDeadline) {
    await client.observe();
    evidence = await client.blockGet(dimension, [target, ...route]);
    const targetKnown = evidence.cells[0]?.state === "KNOWN_BLOCK";
    const routeKnown = evidence.cells.slice(1).every((cell, index) =>
      cell?.state === (index % 3 === 0 ? "KNOWN_BLOCK" : "KNOWN_AIR"));
    if (targetKnown && routeKnown) break;
    await delay(50);
  }
  const targetKnown = evidence?.cells[0]?.state === "KNOWN_BLOCK";
  const routeKnown = evidence?.cells.slice(1).every((cell, index) =>
    cell?.state === (index % 3 === 0 ? "KNOWN_BLOCK" : "KNOWN_AIR"));
  if (!targetKnown || !routeKnown) {
    throw new Error(`${label} route evidence did not converge: ${JSON.stringify(evidence)}`);
  }
  await runtimeCommand(runtime, `tp bot ${start.x + 0.5} ${start.y} ${start.z + 0.5} -90 0`);
  await assertBodyNear(client, { x: start.x + 0.5, y: start.y, z: start.z + 0.5 }, `${label} out-of-reach start`);
  await client.observe();
  return { start, target };
}

async function runOutOfReachBreakSmoke(runtime, client, dimension) {
  console.log("smoke: out-of-reach break completes generic interaction-pose search before exact break");
  const calls = [];
  const abilityRuntime = new AbilityRuntime({
    onEvent(event) {
      if (event.type === "ability_call_started") calls.push(event.ability);
    },
  });
  for (const definition of abilities) await abilityRuntime.register(definition);
  let fixture;
  try {
    fixture = await prepareInteractionPoseFixture(runtime, client, dimension, "diamond_ore", "out-of-reach break");
    await runtimeCommand(runtime, "gamemode survival bot");
    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, "item replace entity bot weapon.mainhand with minecraft:diamond_pickaxe 1");
    const result = await abilityRuntime.dispatch("goto_and_break_block", { position: fixture.target }, {
      runtime: new RuntimeAdapter(client),
    });
    const targetAir = await runtimeCommand(runtime,
      `execute if block ${fixture.target.x} ${fixture.target.y} ${fixture.target.z} air`);
    if (!result.ok
        || JSON.stringify(Object.keys(result.data ?? {})) !== JSON.stringify([
          "position", "observed_drop_entities", "cleared_occluding_blocks",
        ])
        || !sameBlockPosition(result.data?.position, fixture.target)
        || result.data?.cleared_occluding_blocks?.length !== 0
        || calls.filter((ability) => ability === "goto_block_interaction_pose").length !== 1
        || calls.filter((ability) => ability === "break_block").length !== 2
        || !targetAir.includes("Test passed")) {
      throw new Error(`out-of-reach target did not use one complete pose search before breaking: ${JSON.stringify({
        result, calls, targetAir,
      })}`);
    }
  } finally {
    if (fixture !== undefined) {
      await runtimeCommand(runtime,
        `fill ${fixture.start.x - 2} ${fixture.start.y - 1} ${fixture.start.z - 3} ${fixture.target.x + 2} ${fixture.start.y + 2} ${fixture.start.z + 3} air`).catch(() => {});
    }
    await runtimeCommand(runtime, "gamemode creative bot").catch(() => {});
    await runtimeCommand(runtime, "clear bot").catch(() => {});
  }
}

async function runActivationApproachSmoke(runtime, client, dimension) {
  console.log("smoke: goto_and_activate_block approaches and returns only the compact activation result");
  const calls = [];
  const abilityRuntime = new AbilityRuntime({
    onEvent(event) {
      if (event.type === "ability_call_started") calls.push(event.ability);
    },
  });
  for (const definition of abilities) await abilityRuntime.register(definition);
  let fixture;
  try {
    fixture = await prepareInteractionPoseFixture(runtime, client, dimension, "crafting_table", "activation");
    const result = await abilityRuntime.dispatch("goto_and_activate_block", { position: fixture.target }, {
      runtime: new RuntimeAdapter(client),
    });
    if (!result.ok
        || JSON.stringify(Object.keys(result.data ?? {})) !== JSON.stringify(["position", "outcome"])
        || !sameBlockPosition(result.data?.position, fixture.target)
        || result.data?.outcome !== "menu_opened"
        || calls.filter((ability) => ability === "goto_block_interaction_pose").length !== 1
        || calls.filter((ability) => ability === "activate_block").length !== 2
        || calls.includes("break_block")) {
      throw new Error(`goto_and_activate_block did not compactly approach and retry without breaking: ${JSON.stringify({
        result, calls,
      })}`);
    }
    const closed = await client.toolCall("close_gui", {});
    if (!closed.success) throw new Error(`activation smoke did not close its Menu: ${JSON.stringify(closed)}`);
  } finally {
    if (fixture !== undefined) {
      await runtimeCommand(runtime,
        `fill ${fixture.start.x - 2} ${fixture.start.y - 1} ${fixture.start.z - 3} ${fixture.target.x + 2} ${fixture.start.y + 2} ${fixture.start.z + 3} air`).catch(() => {});
    }
  }
}

async function runFailedCollectTargetSmoke(runtime, client, dimension) {
  console.log("smoke: one failed nearest collect target is excluded before the next current-nearest requery");
  const status = await client.toolCall("get_self_status", {});
  const position = status.data?.position;
  if (!status.success || !position || ![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new Error(`failed collect fixture lacked a current body position: ${JSON.stringify(status)}`);
  }
  const origin = { x: Math.floor(position.x) + 12, y: 240, z: Math.floor(position.z) + 12 };
  const failedTarget = { x: origin.x + 2, y: origin.y + 1, z: origin.z };
  const succeedingTarget = { x: origin.x + 7, y: origin.y + 1, z: origin.z };
  const calls = [];
  const abilityRuntime = new AbilityRuntime({
    onEvent(event) {
      if (event.type === "ability_call_started") calls.push({ ability: event.ability, input: event.input });
    },
  });
  for (const definition of abilities) await abilityRuntime.register(definition);
  try {
    await runtimeCommand(runtime,
      `fill ${origin.x - 3} ${origin.y - 1} ${origin.z - 3} ${origin.x + 10} ${origin.y + 3} ${origin.z + 3} air`);
    await runtimeCommand(runtime,
      `fill ${origin.x - 3} ${origin.y - 1} ${origin.z - 3} ${origin.x + 10} ${origin.y - 1} ${origin.z + 3} stone`);
    const failedSet = await runtimeCommand(runtime,
      `setblock ${failedTarget.x} ${failedTarget.y} ${failedTarget.z} minecraft:diamond_ore`);
    const succeedingSet = await runtimeCommand(runtime,
      `setblock ${succeedingTarget.x} ${succeedingTarget.y} ${succeedingTarget.z} minecraft:diamond_ore`);
    const initialTargets = await runtimeCommand(runtime,
      `execute if block ${failedTarget.x} ${failedTarget.y} ${failedTarget.z} minecraft:diamond_ore if block ${succeedingTarget.x} ${succeedingTarget.y} ${succeedingTarget.z} minecraft:diamond_ore`);
    if (!initialTargets.includes("Test passed")) {
      throw new Error(`failed collect fixture targets were not placed: ${JSON.stringify({
        failedSet, succeedingSet, initialTargets, failedTarget, succeedingTarget,
      })}`);
    }
    for (const target of [failedTarget, succeedingTarget]) {
      await runtimeCommand(runtime, `tp bot ${target.x - 2.5} ${origin.y} ${target.z + 0.5} -90 0`);
      let evidence;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await client.observe();
        evidence = await client.blockGet(dimension, [target]);
        if (evidence.cells[0]?.state === "KNOWN_BLOCK") break;
        await delay(50);
      }
      if (evidence?.cells[0]?.state !== "KNOWN_BLOCK") {
        throw new Error(`failed collect target was not remembered: ${JSON.stringify({ target, evidence })}`);
      }
    }
    await runtimeCommand(runtime,
      `fill ${failedTarget.x - 1} ${failedTarget.y} ${failedTarget.z - 1} ${failedTarget.x + 1} ${failedTarget.y + 1} ${failedTarget.z + 1} bedrock`);
    await runtimeCommand(runtime, `setblock ${failedTarget.x} ${failedTarget.y} ${failedTarget.z} diamond_ore`);
    await runtimeCommand(runtime, `tp bot ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5} -90 0`);
    await runtimeCommand(runtime, "gamemode survival bot");
    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, "item replace entity bot weapon.mainhand with minecraft:diamond_pickaxe 1");
    const result = await abilityRuntime.dispatch("collect_blocks", {
      block_id_glob: "minecraft:diamond_ore", count: 1,
    }, { runtime: new RuntimeAdapter(client) });
    const selectedBreaks = calls.filter((call) => call.ability === "goto_and_break_block")
      .map((call) => call.input?.position);
    const succeedingAir = await runtimeCommand(runtime,
      `execute if block ${succeedingTarget.x} ${succeedingTarget.y} ${succeedingTarget.z} air`);
    const failedStillPresent = await runtimeCommand(runtime,
      `execute if block ${failedTarget.x} ${failedTarget.y} ${failedTarget.z} diamond_ore`);
    if (!result.ok
        || result.data?.completed_blocks !== 1
        || !sameBlockPosition(result.data?.completed_positions?.[0], succeedingTarget)
        || result.data?.skipped_positions?.length !== 1
        || !sameBlockPosition(result.data.skipped_positions[0]?.position, failedTarget)
        || calls.filter((call) => call.ability === "find_known_blocks").length < 2
        || JSON.stringify(selectedBreaks) !== JSON.stringify([failedTarget, succeedingTarget])
        || !succeedingAir.includes("Test passed") || !failedStillPresent.includes("Test passed")) {
      throw new Error(`failed nearest target monopolized a collect_blocks call: ${JSON.stringify({
        result, calls, selectedBreaks, succeedingAir, failedStillPresent,
      })}`);
    }
  } finally {
    await runtimeCommand(runtime,
      `fill ${origin.x - 3} ${origin.y - 1} ${origin.z - 3} ${origin.x + 10} ${origin.y + 3} ${origin.z + 3} air`).catch(() => {});
    await runtimeCommand(runtime, "gamemode creative bot").catch(() => {});
    await runtimeCommand(runtime, "clear bot").catch(() => {});
  }
}

async function runCompositeEventLogSmoke(runtime, client, url, dimension) {
  console.log("smoke: compact Composite result leaves complete nested history in the Harness Run Event Log");
  const directory = await mkdtemp(join(tmpdir(), "mc-agent-occlusion-and-reselection-event-log-"));
  let requests = 0;
  try {
    await withOccludingBreakFixture(runtime, client, dimension, async ({ target }) => {
      const model = scriptedSmokeModel(async () => {
          requests += 1;
          return requests === 1
            ? scriptedToolDecision("break-occluded-target", "goto_and_break_block", { position: target })
            : scriptedScenarioEnd();
      });
      const result = await runHarness({
        config: {
          mode: "native", runtime: { url }, bot: { username: "bot" },
          model: smokeModelConfig(),
          data: { directory }, artifacts: { directory },
        },
        agentContext: staticGoalContext("Break the one exact evidence-backed foliage-occluded target."),
        secrets: { modelApiKey: "smoke-script" },
        createRuntimeSession: async () => borrowedRuntimeSession(new RuntimeAdapter(client)),
        languageModel: model,
        modelLimits: model.limits,
      });
      const runDirectories = await readdir(directory);
      const log = await readFile(join(directory, runDirectories[0] ?? "", "events.jsonl"), "utf8");
      const events = log.trim().split("\n").map((line) => JSON.parse(line));
      const root = events.find((event) => event.type === "ability_call_started"
        && event.ability === "goto_and_break_block");
      const nestedBreaks = events.filter((event) => event.type === "ability_call_started"
        && event.ability === "break_block");
      const rootFinished = events.find((event) => event.type === "ability_call_finished"
        && event.ability === "goto_and_break_block");
      if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 2
          || root === undefined || nestedBreaks.length !== 3
          || nestedBreaks.some((event) => event.rootId !== root.rootId
            || event.parentExecutionId !== root.executionId)
          || rootFinished?.result?.ok !== true
          || JSON.stringify(Object.keys(rootFinished.result?.data ?? {})) !== JSON.stringify([
            "position", "observed_drop_entities", "cleared_occluding_blocks",
          ])) {
        throw new Error(`Harness Run Event Log lost nested Composite history or compact result: ${JSON.stringify({
          result, requests, root, nestedBreaks, rootFinished,
        })}`);
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runCollectBlocksSmoke(runtime, client, fixtureX, fixtureY, fixtureZ) {
  console.log("smoke: live collect_blocks requeries current-nearest remembered targets and collects observed drops");
  const origin = { x: fixtureX - 8, y: fixtureY, z: fixtureZ + 8 };
  const firstTarget = { x: origin.x + 2, y: origin.y + 1, z: origin.z };
  const replacementTarget = { x: origin.x - 4, y: origin.y + 1, z: origin.z };
  const currentSecond = { x: origin.x + 6, y: origin.y + 1, z: origin.z };
  const targets = [
    firstTarget,
    replacementTarget,
    currentSecond,
  ];
  const selectedTargets = [
    currentSecond,
    replacementTarget,
  ];
  const calls = [];
  let firstObservedDropKilled = false;
  const abilityRuntime = new AbilityRuntime({
    async onEvent(event) {
      if (event.type === "ability_call_started"
          && ["find_known_blocks", "collect_items"].includes(event.ability)) {
        calls.push(event.ability);
      }
      if (event.type === "ability_call_started" && event.ability === "collect_items"
          && !firstObservedDropKilled) {
        const uuid = event.input?.uuids?.[0];
        if (typeof uuid === "string") {
          firstObservedDropKilled = true;
          await runtimeCommand(runtime,
            `kill ${uuid}`).catch(() => {});
        }
      }
    },
  });
  for (const definition of abilities) await abilityRuntime.register(definition);
  try {
    await runtimeCommand(runtime,
      `fill ${origin.x - 8} ${origin.y - 2} ${origin.z - 3} ${origin.x + 10} ${origin.y + 4} ${origin.z + 3} stone`);
    await runtimeCommand(runtime,
      `fill ${origin.x - 7} ${origin.y} ${origin.z - 2} ${origin.x + 9} ${origin.y + 3} ${origin.z + 2} air`);
    for (const target of targets) {
      await runtimeCommand(runtime, `setblock ${target.x} ${target.y} ${target.z} diamond_ore`);
    }
    const dryStart = await runtimeCommand(runtime,
      `execute if block ${origin.x} ${origin.y} ${origin.z} air if block ${origin.x} ${origin.y + 1} ${origin.z} air`);
    if (!dryStart.includes("Test passed")) {
      throw new Error(`collect_blocks dry fixture was not established: ${JSON.stringify({
        origin, dryStart,
      })}`);
    }
    await runtimeCommand(runtime, "gamemode survival bot");
    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime,
      "item replace entity bot weapon.mainhand with minecraft:diamond_pickaxe 1");
    for (const target of targets) {
      const observationPose = { x: target.x - 2.5, y: origin.y, z: target.z + 0.5 };
      await runtimeCommand(runtime,
        `tp bot ${observationPose.x} ${observationPose.y} ${observationPose.z} -90 0`);
      await assertBodyNear(client, observationPose, "collect_blocks remembered-target setup");
      const targetDeadline = Date.now() + 15_000;
      let targetEvidence;
      while (Date.now() < targetDeadline) {
        await client.observe();
        targetEvidence = await client.blockGet("minecraft:overworld", [target]);
        if (targetEvidence.cells[0]?.state === "KNOWN_BLOCK") break;
        await delay(50);
      }
      if (targetEvidence?.cells[0]?.state !== "KNOWN_BLOCK") {
        throw new Error(`collect_blocks target did not become remembered: ${JSON.stringify({
          target, targetEvidence,
        })}`);
      }
    }
    await runtimeCommand(runtime,
      `tp bot ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5} -90 0`);
    await assertBodyNear(client,
      { x: origin.x + 0.5, y: origin.y, z: origin.z + 0.5 }, "collect_blocks setup");
    await client.observe();
    const evidence = await client.blockGet("minecraft:overworld", targets);
    if (!evidence?.cells.every((cell) => cell?.state === "KNOWN_BLOCK")) {
      throw new Error(`collect_blocks targets did not become remembered known blocks: ${JSON.stringify(evidence)}`);
    }

    const result = await abilityRuntime.dispatch("collect_blocks", {
      block_id_glob: "minecraft:diamond_ore",
      count: 2,
    }, { runtime: new RuntimeAdapter(client) });
    const physical = [];
    for (const target of selectedTargets) {
      physical.push(await runtimeCommand(runtime,
        `execute if block ${target.x} ${target.y} ${target.z} air`));
    }
    const replacementTargetAir = await runtimeCommand(runtime,
      `execute if block ${replacementTarget.x} ${replacementTarget.y} ${replacementTarget.z} air`);
    const diamonds = await matchingItemCount(runtime, "bot", "minecraft:diamond");
    if (!result.ok
        || result.data?.requested_blocks !== 2
        || result.data?.completed_blocks !== 2
        || result.data?.broken_blocks !== 3
        || result.message !== "completed requested block collection with unresolved observed drops"
        || result.data?.collected_items?.["minecraft:diamond"] !== 2
        || JSON.stringify(result.data?.completed_positions) !== JSON.stringify(selectedTargets)
        || result.data?.skipped_positions?.length !== 0
        || result.data?.unresolved_observed_drops?.length !== 1
        || calls.filter((name) => name === "find_known_blocks").length < 3
        || calls.filter((name) => name === "collect_items").length < 3
        || physical.some((value) => !value.includes("Test passed"))
        || !replacementTargetAir.includes("Test passed")
        || diamonds !== 2) {
      throw new Error(`collect_blocks did not reselect current-nearest real-world targets: ${JSON.stringify({
        result, calls, physical, replacementTargetAir, diamonds, targets, selectedTargets,
      })}`);
    }
  } finally {
    await runtimeCommand(runtime,
      `tp bot ${fixtureX + 0.5} ${fixtureY} ${fixtureZ + 0.5} -90 0`).catch(() => {});
    await runtimeCommand(runtime,
      `fill ${origin.x - 8} ${origin.y - 2} ${origin.z - 3} ${origin.x + 10} ${origin.y + 4} ${origin.z + 3} air`).catch(() => {});
    await runtimeCommand(runtime, "gamemode creative bot").catch(() => {});
    await runtimeCommand(runtime, "clear bot").catch(() => {});
  }
}
async function runOcclusionAndReselectionSmoke(runtime, client, url, dimension) {
  await runFoliageCollectionSmoke(runtime, client, dimension);
  await runOutOfReachBreakSmoke(runtime, client, dimension);
  const status = await client.toolCall("get_self_status", {});
  const position = status.data?.position;
  if (!status.success || !position || ![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new Error(`occlusion_and_reselection reselection fixture lacked a current body position: ${JSON.stringify(status)}`);
  }
  await runCollectBlocksSmoke(runtime, client, Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
  await runFailedCollectTargetSmoke(runtime, client, dimension);
  await runActivationApproachSmoke(runtime, client, dimension);
  await runCompositeEventLogSmoke(runtime, client, url, dimension);
}

  return {
    runExactBreakOcclusionSmoke,
    runGotoAndBreakOccludingSmoke,
    runCollectBlocksSmoke,
    runOcclusionAndReselectionSmoke,
  };
}
