import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { borrowedRuntimeSession, staticGoalContext } from "../../../dist/harness/run-harness.js";
import { RuntimeAdapter } from "../../../dist/harness/runtime-adapter.js";
import {
  runScenarioHarness as runHarness,
  scriptedSmokeModel,
  scriptedScenarioEnd, scriptedToolDecision,
  smokeModelConfig,
} from "./test-context.mjs";

const SKILL = new URL("../../../project-skills/nether_portal/SKILL.md", import.meta.url);

/** The nether_portal Skill's ts snippets, in document order: the edge pour, then the frame. */
async function skillSnippets() {
  const text = await readFile(SKILL, "utf8");
  return [...text.matchAll(/```ts\n([\s\S]*?)```/gu)].map((match) => match[1]);
}

/**
 * Live nether_portal workflow on a built fixture: fill_bucket from a water hole, the Skill's edge
 * pour over a 3x3 lava pool, mining the obsidian, then the Skill's frame and ignition.
 */
export async function runObsidianPortalSmoke({ runtime, client, url, dimension, runtimeCommand, matchingItemCount }) {
  console.log("smoke: fill_bucket, the nether_portal edge pour and frame through Harness run_code");
  const [pourSnippet, frameSnippet] = await skillSnippets();
  if (pourSnippet === undefined || frameSnippet === undefined) throw new Error("nether_portal lost its ts snippets");
  const status = await client.toolCall("get_self_status", {});
  const position = status.data?.position;
  if (!status.success || !position) throw new Error(`obsidian fixture lacked a body position: ${JSON.stringify(status)}`);
  const o = { x: Math.floor(position.x) + 24, y: 200, z: Math.floor(position.z) + 24 };
  const water = { x: o.x - 3, y: o.y - 1, z: o.z };
  const lavaCenter = { x: o.x + 5, y: o.y - 1, z: o.z };
  const frameFeet = { x: o.x, y: o.y, z: o.z - 5 };
  const directory = await mkdtemp(join(tmpdir(), "mc-agent-obsidian-portal-"));
  const finished = [];
  const started = new Map();
  let requests = 0;
  let afterPour;

  const waitKnown = async (cell, predicate, label) => {
    const deadline = Date.now() + 15_000;
    let evidence;
    while (Date.now() < deadline) {
      await client.observe();
      evidence = await client.blockGet(dimension, [cell]);
      if (predicate(evidence.cells[0])) return;
      await delay(50);
    }
    throw new Error(`${label} did not become known: ${JSON.stringify(evidence)}`);
  };

  const model = scriptedSmokeModel(async () => {
    requests += 1;
    if (requests === 1) {
      return scriptedToolDecision("pour-for-obsidian", "run_code", {
        description: "Fill a bucket, pour over the lava pool edge, then mine obsidian",
        code: [
          "const filled = await abilities.fill_bucket({ fluid: \"water\" });",
          "if (!filled.ok) return { filled };",
          `const poured = await (async () => {\n${pourSnippet}\n})();`,
          "const mined = await abilities.collect_blocks({ block_id_glob: \"minecraft:obsidian\", count: 4 });",
          "return { filled: filled.message, poured, mined: mined.message };",
        ].join("\n"),
      });
    }
    if (requests === 2) {
      afterPour = {
        obsidian: await matchingItemCount(runtime, "bot", "minecraft:obsidian"),
        waterBucket: await matchingItemCount(runtime, "bot", "minecraft:water_bucket"),
        bucket: await matchingItemCount(runtime, "bot", "minecraft:bucket"),
      };
      await runtimeCommand(runtime, "clear bot minecraft:obsidian");
      await runtimeCommand(runtime, "give bot minecraft:obsidian 10");
      await runtimeCommand(runtime, "give bot minecraft:flint_and_steel 1");
      await runtimeCommand(runtime, `tp bot ${frameFeet.x + 0.5} ${frameFeet.y} ${frameFeet.z + 0.5} -90 0`);
      await delay(500);
      return scriptedToolDecision("build-frame", "run_code", {
        description: "Build and light the portal frame from the Skill",
        code: frameSnippet,
      });
    }
    return scriptedScenarioEnd();
  });

  try {
    await runtimeCommand(runtime, `fill ${o.x - 6} ${o.y - 3} ${o.z - 9} ${o.x + 12} ${o.y + 7} ${o.z + 6} air`);
    await runtimeCommand(runtime, `fill ${o.x - 6} ${o.y - 3} ${o.z - 9} ${o.x + 12} ${o.y - 1} ${o.z + 6} stone`);
    await runtimeCommand(runtime, `setblock ${water.x} ${water.y} ${water.z} water`);
    await runtimeCommand(runtime,
      `fill ${lavaCenter.x - 1} ${lavaCenter.y} ${lavaCenter.z - 1} ${lavaCenter.x + 1} ${lavaCenter.y} ${lavaCenter.z + 1} lava`);
    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, "give bot minecraft:bucket 1");
    await runtimeCommand(runtime, "give bot minecraft:diamond_pickaxe 1");
    await runtimeCommand(runtime, "give bot minecraft:cobblestone 16");
    await runtimeCommand(runtime, `tp bot ${o.x + 0.5} ${o.y} ${o.z + 0.5} -90 0`);
    await waitKnown(lavaCenter, (cell) => cell?.block_state?.startsWith("minecraft:lava"), "lava pool");
    await waitKnown(water, (cell) => cell?.block_state?.startsWith("minecraft:water"), "water hole");

    const result = await runHarness({
      config: {
        mode: "code",
        runtime: { url },
        bot: { username: "bot" },
        model: smokeModelConfig(),
        data: { directory },
        artifacts: { directory },
      },
      agentContext: staticGoalContext("Make obsidian from the lava pool and build a lit Nether portal."),
      secrets: { modelApiKey: "smoke-script" },
      createRuntimeSession: async () => borrowedRuntimeSession(new RuntimeAdapter(client)),
      languageModel: model,
      modelLimits: model.limits,
      onProgress(event) {
        if (event.type === "ability_call_started") started.set(event.executionId, event.input);
        if (event.type === "ability_call_finished") {
          const placing = /place|placement_pose|observe_self/u.test(event.ability) && requests >= 2;
          finished.push({
            ability: event.ability, ok: event.result?.ok, message: event.result?.message,
            ...(placing ? { input: started.get(event.executionId), data: event.result?.data } : {}),
          });
        }
      },
    });
    const base = { x: frameFeet.x + 2, y: frameFeet.y, z: frameFeet.z };
    const portal = await runtimeCommand(runtime,
      `execute if block ${base.x + 1} ${base.y + 1} ${base.z} minecraft:nether_portal`);
    const fill = finished.find(({ ability }) => ability === "fill_bucket");
    const report = { result: result.status, requests, afterPour, portal, fill, finished };
    console.log(JSON.stringify({ event: "obsidian_portal_report", ...report }));
    if (result.status !== "ended" || requests !== 3 || !fill?.ok
        || !(afterPour?.obsidian >= 4) || !portal.includes("Test passed")) {
      throw new Error(`obsidian and portal workflow failed: ${JSON.stringify(report)}`);
    }
  } finally {
    await runtimeCommand(runtime, `fill ${o.x - 6} ${o.y - 3} ${o.z - 9} ${o.x + 12} ${o.y + 7} ${o.z + 6} air`);
    await runtimeCommand(runtime, "clear bot");
    await rm(directory, { recursive: true, force: true });
  }
}
