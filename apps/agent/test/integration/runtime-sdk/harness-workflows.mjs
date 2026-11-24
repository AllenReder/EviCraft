import { runScenarioHarness as runHarness } from "./test-context.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeAdapter } from "../../../dist/harness/runtime-adapter.js";
import { abilities } from "../../../dist/harness/abilities/index.js";
import { borrowedRuntimeSession, staticGoalContext } from "../../../dist/harness/run-harness.js";
import {
  scriptedSmokeModel,
  scriptedScenarioEnd, scriptedToolDecision,
  smokeModelConfig,
} from "./test-context.mjs";

function messageText(message) {
  return message?.content
    ?.filter((block) => block.type === "text" || block.type === "reasoning")
    .map((block) => block.text)
    .join("") ?? "";
}

function freshPreStepContext(request) {
  const message = request.messages.findLast((candidate) =>
    candidate.role === "user" && messageText(candidate).includes("<minecraft_pre_step_context"));
  const match = messageText(message).match(
    /<minecraft_pre_step_context[^>]*>\n([\s\S]*)\n<\/minecraft_pre_step_context>/u,
  );
  if (match?.[1] === undefined) {
    throw new Error("live Harness Decision Request omitted the fresh user-role pre-step context");
  }
  return JSON.parse(match[1]);
}

/** Harness workflows retain their own fixtures, drive, and oracle. */
export function createHarnessWorkflowScenarios({
  runtimeCommand,
  matchingItemCount,
  assertBodyNear,
}) {
  const runRealHarnessNativeSurfaceSmoke = async (client, url) => {
    console.log("smoke: live final Native Mode Ability and Control Tool surface");
    const directory = await mkdtemp(join(tmpdir(), "mc-agent-real-native-surface-"));
    let surfaceVerified = false;
    let navigationPolicyVerified = false;
    const model = scriptedSmokeModel(async (request) => {
      const names = request.tools.map((tool) => tool.name);
      const expected = [
        ...abilities.filter((ability) => ability.visibility !== "internal")
          .map((ability) => ability.name).sort(),
        "load_skill", "update_plan",
      ];
      if (JSON.stringify(names) !== JSON.stringify(expected)
          || names.includes("run_code") || names.includes("interact_at")) {
        throw new Error(`Native Mode Tool surface is wrong: ${JSON.stringify({ names, expected })}`);
      }
      const context = freshPreStepContext(request);
      const policy = context !== null && typeof context === "object" && !Array.isArray(context)
        ? context.navigation_policy
        : undefined;
      if (context === null || typeof context !== "object" || Array.isArray(context)
          || policy === null || typeof policy !== "object" || Array.isArray(policy)
          || policy.action !== "read"
          || !Array.isArray(policy.item_id_globs) || policy.item_id_globs.length > 16
          || !Number.isInteger(policy.effective_item_count)
          || policy.effective_item_count < 0 || policy.effective_item_count > 128
          || !Array.isArray(policy.effective_item_sample) || policy.effective_item_sample.length > 16
          || !Array.isArray(policy.carried_matching_items)
          || typeof context.turn_observation !== "string"
          || context.turn_observation.includes("navigation_policy")
          || Object.hasOwn(context, "world_fact")) {
        throw new Error(`Decision Request navigation_policy projection is wrong: ${JSON.stringify(context)}`);
      }
      navigationPolicyVerified = true;
      surfaceVerified = true;
      return scriptedScenarioEnd();
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
        agentContext: staticGoalContext("Verify the final Native Mode Tool surface."),
        secrets: { modelApiKey: "smoke-script" },
        createRuntimeSession: async () => borrowedRuntimeSession(new RuntimeAdapter(client)),
        languageModel: model,
        modelLimits: model.limits,
      });
      if (!surfaceVerified || !navigationPolicyVerified
          || result.status !== "ended" || result.endReason !== "external_stop") {
        throw new Error(`Native Mode surface smoke did not end cleanly: ${JSON.stringify({
          surfaceVerified, navigationPolicyVerified, result,
        })}`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  const runRealHarnessExplorationSmoke = async (runtime, client, url, restorePosition) => {
    console.log("smoke: live Harness Exploration Excursion discovers evidence after movement");
    const directory = await mkdtemp(join(tmpdir(), "mc-agent-real-search-"));
    const originX = Math.floor(restorePosition.x) + 40;
    const originY = 280;
    const originZ = Math.floor(restorePosition.z);
    const turn = { x: originX + 4, y: originY, z: originZ };
    const end = { x: turn.x, y: originY, z: originZ - 4 };
    const target = { x: end.x, y: originY + 1, z: end.z - 1 };
    const start = { x: originX, y: originY, z: originZ };
    let requests = 0;
    let explorationResult;
    let findResult;
    let loadedSkill = false;
    let planRevision;
    let controlSurfaceVerified = false;
    const gotoInputs = [];
    const model = scriptedSmokeModel(async (request) => {
      requests += 1;
      if (requests === 1) {
        const names = request.tools.map((tool) => tool.name);
        if (JSON.stringify(names) !== JSON.stringify([
          "run_code", "load_skill", "update_plan",
        ])) {
          throw new Error(`Code Mode Control Tool surface is wrong: ${JSON.stringify(names)}`);
        }
        controlSurfaceVerified = true;
        return scriptedToolDecision("explore-for-hidden-block", "run_code", {
          description: "Explore for hidden structure-block evidence, then query it",
          code: "const exploration = await abilities.explore_and_return({ max_outbound_displacement: 32, return_to_start: true, route_seed: 5 }); if (!exploration.ok) return exploration; return await abilities.find_known_blocks({ block_id_glob: 'minecraft:structure_block' });",
        });
      }
      if (requests === 2) {
        return scriptedToolDecision("load-smelt-craft-skill", "load_skill", { name: "smelt_craft" });
      }
      if (requests === 3) {
        return scriptedToolDecision("update-search-plan", "update_plan", {
          items: [{ id: "search", content: "Verify bounded block search", status: "completed" }],
        });
      }
      return scriptedScenarioEnd();
    });
    try {
      await runtimeCommand(runtime,
        `fill ${originX - 6} ${originY - 2} ${originZ - 6} ${originX + 8} ${originY + 5} ${originZ + 6} air`);
      await runtimeCommand(runtime,
        `fill ${start.x} ${originY - 1} ${start.z} ${turn.x} ${originY - 1} ${turn.z} stone`);
      await runtimeCommand(runtime,
        `fill ${end.x} ${originY - 1} ${end.z} ${turn.x} ${originY - 1} ${turn.z} stone`);
      await runtimeCommand(runtime,
        `fill ${turn.x - 1} ${originY} ${turn.z - 5} ${turn.x - 1} ${originY + 2} ${turn.z - 1} stone`);
      await runtimeCommand(runtime,
        `fill ${end.x - 1} ${originY} ${end.z - 1} ${end.x + 1} ${originY + 2} ${end.z - 1} stone`);
      await runtimeCommand(runtime,
        `tp bot ${end.x + 0.5} ${end.y} ${end.z + 0.5} 0 45`);
      await assertBodyNear(client,
        { x: end.x + 0.5, y: end.y, z: end.z + 0.5 }, "terminal corridor evidence seed");
      await client.observe();
      await runtimeCommand(runtime,
        `tp bot ${originX + 2.5} ${originY} ${originZ + 0.5} -90 45`);
      await assertBodyNear(client,
        { x: originX + 2.5, y: originY, z: originZ + 0.5 }, "corridor evidence seed");
      await client.observe();
      await runtimeCommand(runtime,
        `tp bot ${originX + 0.5} ${originY} ${originZ + 0.5} -90 45`);
      await assertBodyNear(client,
        { x: originX + 0.5, y: originY, z: originZ + 0.5 }, "block-search setup");
      await runtimeCommand(runtime,
        `setblock ${target.x} ${target.y} ${target.z} structure_block`);
      await client.observe();
      const before = await client.blockFind("minecraft:overworld", "minecraft:structure_block");
      if (before.matches.length !== 0) {
        throw new Error(`block-search target was visible before movement: ${JSON.stringify(before)}`);
      }

      const result = await runHarness({
        config: {
          mode: "code",
          runtime: { url },
          bot: { username: "bot" },
          model: smokeModelConfig(),
          data: { directory },
          artifacts: { directory },
        },
        agentContext: staticGoalContext("Discover the hidden structure block through bounded horizontal exploration."),
        secrets: { modelApiKey: "smoke-script" },
        createRuntimeSession: async () => borrowedRuntimeSession(new RuntimeAdapter(client)),
        languageModel: model,
        modelLimits: model.limits,
        onProgress(event) {
          if (event.type === "ability_call_started" && event.ability === "goto") {
            gotoInputs.push(event.input);
          }
          if (event.type === "ability_call_finished" && event.ability === "explore_and_return") {
            explorationResult = event.result;
          }
          if (event.type === "ability_call_finished" && event.ability === "find_known_blocks") {
            findResult = event.result;
          }
          if (event.type === "outer_call_finished" && event.tool === "load_skill") {
            loadedSkill = event.outcome === "ok"
              && event.result?.result?.data?.name === "smelt_craft";
          }
          if (event.type === "outer_call_finished" && event.tool === "update_plan") {
            planRevision = event.result?.result?.revision;
          }
        },
      });
      const matches = findResult?.data?.matches;
      const found = matches?.[0];
      const returned = await client.toolCall("get_self_status", {});
      const stayedOnCorridor = gotoInputs.every((input) => input && typeof input === "object"
        && input.y === originY
        && JSON.stringify(input.route_mutation_permissions) === JSON.stringify(["OPEN"])
        && ((input.z === originZ && input.x >= start.x && input.x <= turn.x)
          || (input.x === turn.x && input.z >= end.z && input.z <= turn.z)));
      if (result.status !== "ended" || result.endReason !== "external_stop"
          || requests !== 4 || !controlSurfaceVerified || !loadedSkill || planRevision !== 1
          || explorationResult?.ok !== true
          || explorationResult.data?.outbound_displacement < 8
          || explorationResult.data?.outbound_displacement > 32
          || JSON.stringify(explorationResult.data?.start_feet) !== JSON.stringify(start)
          || findResult?.ok !== true || matches?.length !== 1
          || JSON.stringify(found?.position) !== JSON.stringify(target)
          || found?.block_state !== "minecraft:structure_block[mode=load]"
          || gotoInputs.length < 4 || !stayedOnCorridor
          || returned.success !== true
          || JSON.stringify(returned.data?.feet) !== JSON.stringify(start)) {
        throw new Error(`Harness Exploration Excursion did not discover the movement-acquired target: ${JSON.stringify({
          result, requests, controlSurfaceVerified, loadedSkill, planRevision,
          explorationResult, findResult, gotoInputs, stayedOnCorridor, target, returned,
        })}`);
      }
    } finally {
      await runtimeCommand(runtime,
        `fill ${originX - 6} ${originY - 2} ${originZ - 6} ${originX + 8} ${originY + 5} ${originZ + 6} air`);
      const targetCleared = await runtimeCommand(runtime,
        `execute if block ${target.x} ${target.y} ${target.z} air`);
      await runtimeCommand(runtime,
        `tp bot ${restorePosition.x} ${restorePosition.y} ${restorePosition.z}`);
      await assertBodyNear(client, restorePosition, "Exploration Excursion cleanup", 0.05);
      if (!targetCleared.includes("Test passed")) {
        throw new Error(`Exploration Excursion cleanup retained the hidden target: ${targetCleared}`);
      }
      await rm(directory, { recursive: true, force: true });
    }
  };

  const runSmeltAtFurnaceSmoke = async (runtime, client, url, furnace, dimension) => {
    console.log("smoke: live smelt_at_furnace uses existing and caller-authorized fuel through Harness");
    const directory = await mkdtemp(join(tmpdir(), "mc-agent-real-smelting-"));
    let requests = 0;
    let smelted;
    const model = scriptedSmokeModel(async () => {
      requests += 1;
      if (requests === 1) {
        return scriptedToolDecision("smelt-at-furnace", "run_code", {
          description: "Smelt two raw iron with bounded existing and caller fuel",
          code: `return await abilities.smelt_at_furnace(${JSON.stringify({
            input_item: "minecraft:raw_iron",
            count: 2,
            fuel_item: "minecraft:coal",
            fuel_count: 1,
            position: furnace,
          })});`,
        });
      }
      return scriptedScenarioEnd();
    });
    try {
      await client.toolCall("close_gui", {});
      await runtimeCommand(runtime, `setblock ${furnace.x} ${furnace.y} ${furnace.z} air`);
      await runtimeCommand(runtime, `setblock ${furnace.x} ${furnace.y} ${furnace.z} furnace`);
      await runtimeCommand(runtime,
        `item replace block ${furnace.x} ${furnace.y} ${furnace.z} container.1 with minecraft:oak_planks 1`);
      await runtimeCommand(runtime, "clear bot");
      await runtimeCommand(runtime, "give bot minecraft:raw_iron 2");
      await runtimeCommand(runtime, "give bot minecraft:coal 1");
      const evidenceDeadline = Date.now() + 15_000;
      let evidence;
      while (Date.now() < evidenceDeadline) {
        await client.observe();
        evidence = await client.blockGet(dimension, [furnace]);
        if (evidence.cells[0]?.block_state?.startsWith("minecraft:furnace")) break;
        await delay(50);
      }
      if (!evidence?.cells[0]?.block_state?.startsWith("minecraft:furnace")) {
        throw new Error(`smelt_at_furnace target did not become evidence-bound: ${JSON.stringify(evidence)}`);
      }

      const result = await runHarness({
        config: {
          mode: "code",
          runtime: { url },
          bot: { username: "bot" },
          model: smokeModelConfig(),
          data: { directory },
          artifacts: { directory },
        },
        agentContext: staticGoalContext("Smelt two raw iron in the exact evidence-backed ordinary furnace."),
        secrets: { modelApiKey: "smoke-script" },
        createRuntimeSession: async () => borrowedRuntimeSession(new RuntimeAdapter(client)),
        languageModel: model,
        modelLimits: model.limits,
        onProgress(event) {
          if (event.type === "ability_call_finished" && event.ability === "smelt_at_furnace") {
            smelted = event.result;
          }
        },
      });
      const rawIron = await matchingItemCount(runtime, "bot", "minecraft:raw_iron");
      const coal = await matchingItemCount(runtime, "bot", "minecraft:coal");
      const ingots = await matchingItemCount(runtime, "bot", "minecraft:iron_ingot");
      const closed = await client.toolCall("inspect_gui", {});
      if (result.status !== "ended" || result.endReason !== "external_stop" || requests !== 2
          || !smelted?.ok
          || smelted.data?.position?.x !== furnace.x
          || smelted.data?.position?.y !== furnace.y
          || smelted.data?.position?.z !== furnace.z
          || smelted.data?.inserted_input !== 2
          || smelted.data?.processed_input !== 2
          || smelted.data?.collected_output?.item_id !== "minecraft:iron_ingot"
          || smelted.data?.collected_output?.count !== 2
          || smelted.data?.inserted_fuel !== 1
          || smelted.data?.remaining_fuel_budget !== 0
          || smelted.data?.remaining_input !== 0
          || rawIron !== 0 || coal !== 0 || ingots !== 2
          || !closed.success || closed.data?.own_inventory !== true) {
        throw new Error(`smelt_at_furnace did not complete verified ordinary-furnace processing: ${JSON.stringify({
          result, requests, smelted, rawIron, coal, ingots, closed,
        })}`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  return {
    runRealHarnessNativeSurfaceSmoke,
    runRealHarnessExplorationSmoke,
    runSmeltAtFurnaceSmoke,
  };
}
