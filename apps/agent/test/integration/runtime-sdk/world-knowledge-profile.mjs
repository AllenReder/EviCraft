import { setTimeout as delay } from "node:timers/promises";
import { RuntimeClient } from "../../../../../runtime/sdk/typescript/dist/index.js";
import { sameBlockPosition } from "./test-context.mjs";

/**
 * Exercises the profile-specific World Knowledge, navigation, reconnect, and
 * body lifecycle contracts.  Runtime/process ownership stays in the caller;
 * this module owns only the profile fixture, drive, and oracle.
 */
export async function runWorldKnowledgeProfileSmoke({
  client,
  url,
  token,
  actor,
  profile,
  command,
  assertBodyNear,
  waitForBodyOnGround,
  waitForExactBlock,
}) {
  console.log(`smoke: deterministic ${profile} World Knowledge Profile behavior`);
  const initialStatus = await client.toolCall("get_self_status", {});
  const position = initialStatus.data?.position;
  const dimension = initialStatus.data?.dimension;
  if (!initialStatus.success || typeof dimension !== "string" || !position
      || ![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new Error(`profile fixture lacked current body status: ${JSON.stringify(initialStatus)}`);
  }
  const feet = {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  };
  const knownActionTarget = { x: feet.x + 2, y: feet.y, z: feet.z };
  const blockTarget = { x: feet.x + 9, y: feet.y, z: feet.z };
  const remote = { x: feet.x + 1_000_000, y: feet.y, z: feet.z };
  const sheepTag = `mcagent_profile_${profile}`;
  let activeClient = client;
  try {
    await command(
      `fill ${feet.x - 3} ${feet.y - 2} ${feet.z - 5} ${feet.x + 18} ${feet.y + 5} ${feet.z + 5} air`);
    await command(
      `fill ${feet.x - 3} ${feet.y - 1} ${feet.z - 5} ${feet.x + 18} ${feet.y - 1} ${feet.z + 5} stone`);
    await command(
      `setblock ${knownActionTarget.x} ${knownActionTarget.y} ${knownActionTarget.z} stone`);
    await command(`tp bot ${feet.x + 0.5} ${feet.y} ${feet.z + 0.5} -90 0`);
    await assertBodyNear(
      activeClient,
      { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 },
      "profile fixture start",
      0.75,
    );
    await waitForBodyOnGround(activeClient, "profile fixture start");

    const inside = await waitForExactBlock(
      activeClient, dimension, knownActionTarget, (cell) => cell?.state === "KNOWN_BLOCK",
      "inside exact block",
    );
    if (profile === "loaded_world_state" && inside.source !== "loaded_world_state") {
      throw new Error(`loaded inside exact block had wrong provenance: ${JSON.stringify(inside)}`);
    }
    const outside = await activeClient.blockGet(dimension, [remote]);
    if (outside.cells[0]?.state !== "UNKNOWN") {
      throw new Error(`outside exact block was not UNKNOWN: ${JSON.stringify(outside)}`);
    }

    await command("clear bot");
    await command(`tp bot ${feet.x + 15.5} ${feet.y} ${feet.z + 0.5} 90 0`);
    await assertBodyNear(
      activeClient,
      { x: feet.x + 15.5, y: feet.y, z: feet.z + 0.5 },
      "PVA-invalid exact action start",
      0.75,
    );
    const rejectedBreak = await activeClient.toolCall("break_block", { position: knownActionTarget });
    const targetAfterRejection = await command(
      `execute if block ${knownActionTarget.x} ${knownActionTarget.y} ${knownActionTarget.z} stone`);
    if (rejectedBreak.success || rejectedBreak.data?.failure_type !== "out_of_reach"
        || !targetAfterRejection.includes("Test passed")) {
      throw new Error(`knowledge-bound PVA-invalid action changed its exact target: ${JSON.stringify({ rejectedBreak, targetAfterRejection })}`);
    }
    const legalPose = await activeClient.toolCall("goto_block_interaction_pose", {
      position: knownActionTarget,
    });
    const legalBreak = await activeClient.toolCall("break_block", { position: knownActionTarget });
    const targetAfterSuccess = await command(
      `execute if block ${knownActionTarget.x} ${knownActionTarget.y} ${knownActionTarget.z} air`);
    if (!legalPose.success || !legalBreak.success || !targetAfterSuccess.includes("Test passed")) {
      throw new Error(`same exact action did not succeed from a legal pose: ${JSON.stringify({ legalPose, legalBreak, targetAfterSuccess })}`);
    }

    await command(
      `setblock ${blockTarget.x} ${blockTarget.y} ${blockTarget.z} structure_block`);
    await waitForExactBlock(
      activeClient, dimension, blockTarget,
      (cell) => cell?.state === "KNOWN_BLOCK" && cell.block_state?.startsWith("minecraft:structure_block"),
      "block navigation target",
    );
    const boundedFind = await activeClient.blockFind(
      dimension, "minecraft:structure_block", { origin: feet, limit: 1 },
    );
    if (boundedFind.matches.length !== 1 || boundedFind.has_more !== false
        || !sameBlockPosition(boundedFind.matches[0]?.position, blockTarget)) {
      throw new Error(`bounded block.find did not return only the fixture target: ${JSON.stringify(boundedFind)}`);
    }
    const completeRegion = await activeClient.blockRegion(dimension, blockTarget, blockTarget);
    const completeCell = completeRegion.palette[completeRegion.indices[0]];
    const incompleteRegion = await activeClient.blockRegion(dimension, remote, remote);
    const incompleteCell = incompleteRegion.palette[incompleteRegion.indices[0]];
    if (!completeRegion.complete || completeCell?.state !== "KNOWN_BLOCK"
        || incompleteRegion.complete || incompleteCell?.state !== "UNKNOWN") {
      throw new Error(`profile block.region completeness was wrong: ${JSON.stringify({ completeRegion, incompleteRegion })}`);
    }

    const blockNavigation = await activeClient.toolCall("goto", {
      goal: { kind: "block", block_id_glob: "minecraft:structure_block" },
    });
    const afterBlockNavigation = await activeClient.toolCall("get_self_status", {});
    const navigatedPosition = afterBlockNavigation.data?.position;
    if (!blockNavigation.success || !navigatedPosition
        || Math.hypot(navigatedPosition.x - (blockTarget.x + 0.5),
          navigatedPosition.z - (blockTarget.z + 0.5)) > 3) {
      throw new Error(`block target navigation did not approach the exact known target: ${JSON.stringify({ blockNavigation, afterBlockNavigation })}`);
    }

    await command(`kill @e[tag=${sheepTag}]`);
    await command("clear bot");
    await command("give bot minecraft:shears 1");
    await command(
      `summon minecraft:sheep ${feet.x + 15.5} ${feet.y} ${feet.z + 0.5} {NoAI:1b,Invulnerable:1b,Tags:[\"${sheepTag}\"]}`);
    let sheep;
    const sheepDeadline = Date.now() + 20_000;
    while (Date.now() < sheepDeadline && sheep === undefined) {
      await activeClient.observe();
      const tracks = await activeClient.entityList({
        dimension, entityIdGlob: "minecraft:sheep",
      });
      sheep = tracks.tracks.find((track) => track.state === "VISIBLE"
        && track.position.x > feet.x + 14 && track.position.x < feet.x + 17);
      if (sheep === undefined) await delay(50);
    }
    if (sheep === undefined) throw new Error("profile sheep did not enter exact Entity Knowledge");
    const exactSheep = (await activeClient.entityGet(sheep.uuid)).track;
    for (const track of [sheep, exactSheep]) {
      if (track === null || "health" in track || "max_health" in track) {
        throw new Error(`${profile} entity queries exposed health or lost the living target: ${JSON.stringify(track)}`);
      }
    }
    const entityInteraction = await activeClient.toolCall("interact_entity", {
      uuid: sheep.uuid, hold_ticks: null, item_id: "minecraft:shears",
    });
    const sheared = await command(
      `data get entity @e[tag=${sheepTag},limit=1] Sheared`);
    const afterEntityNavigation = await activeClient.toolCall("get_self_status", {});
    const entityPositionAfter = afterEntityNavigation.data?.position;
    if (!entityInteraction.success || !sheared.includes("1b") || !entityPositionAfter
        || Math.hypot(entityPositionAfter.x - sheep.position.x,
          entityPositionAfter.z - sheep.position.z) > 5) {
      throw new Error(`exact Entity Knowledge target was not navigated to and interacted with: ${JSON.stringify({ entityInteraction, sheared, afterEntityNavigation, sheep })}`);
    }
    const updatedSheep = (await activeClient.entityGet(sheep.uuid)).track;
    const updatedSheepList = await activeClient.entityList({ dimension, entityIdGlob: "minecraft:sheep" });
    const listedSheep = updatedSheepList.tracks.find((track) => track.uuid === sheep.uuid);
    for (const track of [updatedSheep, listedSheep]) {
      if (track == null || "health" in track || "max_health" in track) {
        throw new Error(`${profile} entity queries exposed health or lost the target after interaction: ${JSON.stringify(track)}`);
      }
    }

    activeClient.close();
    activeClient = await RuntimeClient.connect({ url, bearerToken: token });
    const reconnectedActor = await activeClient.actorGet();
    const reconnectedInfo = await activeClient.runtimeInfo();
    if (reconnectedActor?.uuid !== actor.uuid || reconnectedActor.lifecycle_state !== "alive"
        || reconnectedInfo.world_knowledge_profile !== profile) {
      throw new Error(`SDK reconnect did not preserve actor/Profile: ${JSON.stringify({ reconnectedActor, reconnectedInfo })}`);
    }

    const lifecycle = [];
    const stopLifecycle = activeClient.onOccurrence((occurrence) => {
      if (occurrence.type === "actor_lifecycle_changed") lifecycle.push(occurrence.data);
    });
    const beforeDeath = await activeClient.toolCall("get_self_status", {});
    const beforeDeathPosition = beforeDeath.data?.position;
    if (!beforeDeath.success || !beforeDeathPosition) {
      throw new Error(`death fixture lacked current body status: ${JSON.stringify(beforeDeath)}`);
    }
    const activeNavigation = activeClient.startToolCall("goto", {
      goal: { kind: "column", x: Math.floor(beforeDeathPosition.x) + 100, z: Math.floor(beforeDeathPosition.z) + 100 },
    });
    const busyDeadline = Date.now() + 10_000;
    let busy;
    while (Date.now() < busyDeadline) {
      busy = await activeClient.toolCall("goto", { goal: { kind: "elevation", y: Math.floor(beforeDeathPosition.y) + 10 } });
      if (!busy.success && busy.failure_type === "busy") break;
      await delay(25);
    }
    if (busy?.success || busy?.failure_type !== "busy") {
      throw new Error(`death fixture did not establish an active body task: ${JSON.stringify(busy)}`);
    }
    await command("kill bot");
    const unavailableResult = await Promise.race([
      activeNavigation.result,
      delay(10_000).then(() => { throw new Error("death did not terminate the active body task"); }),
    ]);
    const respawnDeadline = Date.now() + 20_000;
    let respawnedActor;
    while (Date.now() < respawnDeadline) {
      respawnedActor = await activeClient.actorGet();
      const sawUnavailableLifecycle = lifecycle.some((value) =>
        value.lifecycle_state === "dead" || value.lifecycle_state === "respawning");
      if (sawUnavailableLifecycle && respawnedActor?.lifecycle_state === "alive") break;
      await delay(25);
    }
    stopLifecycle();
    const respawnInfo = await activeClient.runtimeInfo();
    if (!lifecycle.some((value) => value.lifecycle_state === "dead")
        || !lifecycle.some((value) => value.lifecycle_state === "respawning")
        || unavailableResult.success || unavailableResult.interrupted !== true
        || respawnedActor?.lifecycle_state !== "alive"
        || respawnedActor.uuid !== actor.uuid
        || respawnInfo.readiness !== "ready"
        || respawnInfo.world_knowledge_profile !== profile) {
      throw new Error(`death/body-unavailable/respawn did not preserve actor/Profile: ${JSON.stringify({ lifecycle, unavailableResult, respawnedActor, respawnInfo })}`);
    }
  } finally {
    await command(`kill @e[tag=${sheepTag}]`).catch(() => {});
    await command(
      `fill ${feet.x - 3} ${feet.y - 2} ${feet.z - 5} ${feet.x + 18} ${feet.y + 5} ${feet.z + 5} air`).catch(() => {});
  }
  return activeClient;
}
