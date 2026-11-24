import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

async function entityPosition(command, entity) {
  const response = await command(`data get entity ${entity} Pos`);
  const coordinates = response.match(/\[([^\]]+)\]/)?.[1]
    ?.split(",")
    .map((value) => Number.parseFloat(value));
  if (!coordinates || coordinates.length !== 3 || !coordinates.every(Number.isFinite)) {
    throw new Error(`could not parse ${entity} position: ${response}`);
  }
  return { x: coordinates[0], y: coordinates[1], z: coordinates[2] };
}

async function waitForEntityTrack(client, uuid, expectedState, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    await client.observe();
    last = await client.entityGet(uuid);
    if (last.track?.state === expectedState) return last.track;
    await delay(50);
  }
  throw new Error(`Entity Track ${uuid} did not become ${expectedState}: ${JSON.stringify(last)}`);
}

async function waitForNewVisibleItemTracks(
  client, dimension, itemIdGlob, existingUuids, expectedCount, label,
) {
  const deadline = Date.now() + 15_000;
  let tracks = [];
  while (Date.now() < deadline) {
    await client.observe();
    tracks = (await client.entityList({
      dimension,
      entityIdGlob: "minecraft:item",
      itemIdGlob,
    })).tracks.filter((track) => !existingUuids.has(track.uuid) && track.state === "VISIBLE");
    if (tracks.length >= expectedCount) return tracks;
    await delay(50);
  }
  throw new Error(`${label} were not VISIBLE: ${JSON.stringify(tracks)}`);
}

export async function runEntityCollectionCombatSmoke({
  client,
  dimension,
  bodyPosition,
  bodyX,
  bodyY,
  bodyZ,
  command,
  assertBodyNear,
  matchingItemCount,
}) {
  console.log("smoke: visible Entity Track reacquisition through TypeScript SDK");
  const arenaX = bodyX;
  const arenaY = 200;
  const arenaZ = bodyZ;
  const sheepTag = "mcagent_sdk_interact_entity";
  await command(
    `kill @e[type=minecraft:sheep,x=${arenaX - 12},y=${arenaY - 2},z=${arenaZ - 12},dx=26,dy=8,dz=24]`);
  await client.observe();
  const sheepBefore = new Set((await client.entityList({
    dimension,
    entityIdGlob: "minecraft:sheep",
  })).tracks.map((track) => track.uuid));
  await command(`kill @e[tag=${sheepTag}]`);
  await command(`fill ${arenaX - 12} ${arenaY - 2} ${arenaZ - 12} ${arenaX + 14} ${arenaY + 6} ${arenaZ + 12} air`);
  await command(`fill ${arenaX - 12} ${arenaY - 1} ${arenaZ - 12} ${arenaX + 14} ${arenaY - 1} ${arenaZ + 12} stone`);
  await command(`tp bot ${arenaX + 0.5} ${arenaY} ${arenaZ + 0.5} -90 0`);
  await assertBodyNear(client, { x: arenaX + 0.5, y: arenaY, z: arenaZ + 0.5 },
    "interact_entity setup");
  await client.observe();
  await command("clear bot");
  await command("give bot minecraft:shears 1");
  await command(`summon minecraft:sheep ${arenaX + 4.5} ${arenaY} ${arenaZ + 0.5} {NoAI:1b,Invulnerable:1b,Tags:[\"${sheepTag}\"]}`);

  let visibleSheep;
  const visibleDeadline = Date.now() + 15_000;
  while (Date.now() < visibleDeadline && !visibleSheep) {
    await client.observe();
    const sheepTracks = await client.entityList({
      dimension,
      entityIdGlob: "minecraft:sheep",
    });
    visibleSheep = sheepTracks.tracks.find((track) => !sheepBefore.has(track.uuid)
      && track.state === "VISIBLE");
    if (!visibleSheep) await delay(50);
  }
  if (!visibleSheep) {
    throw new Error("summoned SDK smoke sheep did not become a VISIBLE UUID Entity Track");
  }
  if ("health" in visibleSheep || "max_health" in visibleSheep) {
    throw new Error(`entity.list exposed external entity health: ${JSON.stringify(visibleSheep)}`);
  }
  const frozenPosition = { ...visibleSheep.position };
  await command(`fill ${arenaX + 6} ${arenaY} ${arenaZ - 10} ${arenaX + 6} ${arenaY + 5} ${arenaZ + 10} stone`);
  await command(`tp @e[tag=${sheepTag},limit=1] ${arenaX + 8.5} ${arenaY} ${arenaZ + 0.5}`);
  const knownSheep = await waitForEntityTrack(client, visibleSheep.uuid, "KNOWN");
  if ("health" in knownSheep || "max_health" in knownSheep) {
    throw new Error(`entity.get exposed remembered entity health: ${JSON.stringify(knownSheep)}`);
  }
  if (["x", "y", "z"].some((axis) => knownSheep.position[axis] !== frozenPosition[axis])) {
    throw new Error(`occluded Entity Track did not preserve its frozen position: ${JSON.stringify({ frozenPosition, knownSheep })}`);
  }

  let entityCallSettled = false;
  let entityCallResult;
  const reacquisitionCall = client.startToolCall("interact_entity", {
    uuid: visibleSheep.uuid,
    hold_ticks: null,
    item_id: "minecraft:shears",
  });
  reacquisitionCall.result.then(
    (result) => {
      entityCallSettled = true;
      entityCallResult = result;
    },
    (error) => {
      entityCallSettled = true;
      entityCallResult = { rejected: String(error) };
    },
  );
  await delay(300);
  const stillKnown = await client.entityGet(visibleSheep.uuid);
  const hiddenShearedOutput = await command(
    `data get entity @e[tag=${sheepTag},limit=1] Sheared`);
  if (entityCallSettled || stillKnown.track?.state !== "KNOWN"
      || hiddenShearedOutput.includes("1b")) {
    throw new Error(`interact_entity did not wait at frozen KNOWN evidence: ${JSON.stringify({ entityCallSettled, entityCallResult, stillKnown, hiddenShearedOutput })}`);
  }

  await command(`fill ${arenaX + 6} ${arenaY} ${arenaZ - 10} ${arenaX + 6} ${arenaY + 5} ${arenaZ + 10} air`);
  await command(`tp @e[tag=${sheepTag},limit=1] ${frozenPosition.x} ${frozenPosition.y} ${frozenPosition.z}`);
  const reacquiredSheep = await waitForEntityTrack(client, visibleSheep.uuid, "VISIBLE");
  const entityInteraction = await Promise.race([
    reacquisitionCall.result,
    delay(30_000).then(() => { throw new Error("interact_entity timed out after VISIBLE reacquisition"); }),
  ]);
  if (!entityInteraction.success || reacquiredSheep.uuid !== visibleSheep.uuid) {
    throw new Error(`same VISIBLE UUID was not interacted with: ${JSON.stringify({ reacquiredSheep, entityInteraction })}`);
  }
  const shearedOutput = await command(
    `data get entity @e[tag=${sheepTag},limit=1] Sheared`);
  if (!shearedOutput.includes("1b")) {
    throw new Error(`successful interact_entity did not physically shear the VISIBLE UUID: ${JSON.stringify({ entityInteraction, shearedOutput })}`);
  }
  await command(`kill @e[tag=${sheepTag}]`);
  await command("clear bot");
  await command(`tp bot ${arenaX + 0.5} ${arenaY} ${arenaZ + 0.5} -90 0`);
  await assertBodyNear(client, { x: arenaX + 0.5, y: arenaY, z: arenaZ + 0.5 },
    "collect_items setup");

  console.log("smoke: knowledge-bound collection through TypeScript SDK");
  const collectNearTag = "mcagent_sdk_collect_near";
  const collectFarTag = "mcagent_sdk_collect_far";
  const collectExactTag = "mcagent_sdk_collect_exact";
  const collectPartialLostTag = "mcagent_sdk_collect_partial_lost";
  const collectPartialSurvivorTag = "mcagent_sdk_collect_partial_survivor";
  const collectAllLostTag = "mcagent_sdk_collect_all_lost";
  const collectHiddenTag = "mcagent_sdk_collect_hidden";
  await command(
    `kill @e[type=minecraft:item,x=${arenaX - 12},y=${arenaY - 2},z=${arenaZ - 12},dx=32,dy=8,dz=24]`);
  await delay(20_500);
  await client.observe();
  const shellBefore = new Set((await client.entityList({
    dimension,
    entityIdGlob: "minecraft:item",
    itemIdGlob: "minecraft:nautilus_shell",
  })).tracks.map((track) => track.uuid));
  await command(`summon minecraft:item ${arenaX + 2.5} ${arenaY} ${arenaZ + 0.5} {Item:{id:\"minecraft:nautilus_shell\",count:1},PickupDelay:32767s,NoGravity:1b,Tags:[\"${collectNearTag}\"]}`);
  await command(`summon minecraft:item ${arenaX + 24.5} ${arenaY} ${arenaZ + 0.5} {Item:{id:\"minecraft:nautilus_shell\",count:1},PickupDelay:32767s,NoGravity:1b,Tags:[\"${collectFarTag}\"]}`);
  let nearShell;
  let farShell;
  const shellDeadline = Date.now() + 15_000;
  while (Date.now() < shellDeadline && (!nearShell || !farShell)) {
    await client.observe();
    const tracks = (await client.entityList({
      dimension,
      entityIdGlob: "minecraft:item",
      itemIdGlob: "minecraft:nautilus_shell",
    })).tracks.filter((track) => !shellBefore.has(track.uuid)
      && track.state === "VISIBLE");
    nearShell = tracks.find((track) => track.position.x < arenaX + 10);
    farShell = tracks.find((track) => track.position.x > arenaX + 23);
    if (!nearShell || !farShell) await delay(50);
  }
  if (!nearShell || !farShell) {
    throw new Error(`SDK did not observe both collection radius fixtures: ${JSON.stringify({ nearShell, farShell })}`);
  }
  const frozenShell = { ...nearShell.position };
  await command(`fill ${arenaX + 4} ${arenaY} ${arenaZ - 10} ${arenaX + 4} ${arenaY + 5} ${arenaZ + 10} stone`);
  await command(`tp @e[tag=${collectNearTag},limit=1] ${arenaX + 6.5} ${arenaY} ${arenaZ + 0.5}`);
  const knownShell = await waitForEntityTrack(client, nearShell.uuid, "KNOWN");
  if (["x", "y", "z"].some((axis) => knownShell.position[axis] !== frozenShell[axis])) {
    throw new Error(`collection target did not retain its frozen Track position: ${JSON.stringify({ frozenShell, knownShell })}`);
  }
  let collectionSettled = false;
  const globCollection = client.startToolCall("collect_items", {
    uuids: null,
    item_id_glob: "minecraft:nautilus_shell",
    radius: null,
  });
  globCollection.result.then(
    () => { collectionSettled = true; },
    () => { collectionSettled = true; },
  );
  await delay(75);
  const stillKnownShell = await client.entityGet(nearShell.uuid);
  if (collectionSettled || stillKnownShell.track?.state !== "KNOWN"
      || ["x", "y", "z"].some((axis) => stillKnownShell.track.position[axis]
        !== frozenShell[axis])) {
    throw new Error(`collect_items did not wait at frozen KNOWN evidence: ${JSON.stringify({ collectionSettled, stillKnownShell })}`);
  }
  await command(`fill ${arenaX + 4} ${arenaY} ${arenaZ - 10} ${arenaX + 4} ${arenaY + 5} ${arenaZ + 10} air`);
  await command(`data merge entity @e[tag=${collectNearTag},limit=1] {PickupDelay:0s}`);
  await command(
    `execute at bot run tp @e[tag=${collectNearTag},limit=1] ~ ~ ~`);
  const globCollectionResult = await Promise.race([
    globCollection.result,
    delay(30_000).then(() => { throw new Error("Glob collect_items timed out after VISIBLE reacquisition"); }),
  ]);
  const removedNearTrack = await client.entityGet(nearShell.uuid);
  const farEntityOutput = await command(
    `data get entity @e[tag=${collectFarTag},limit=1] UUID`);
  if (!globCollectionResult.success
      || globCollectionResult.data?.collected_entities !== 1
      || globCollectionResult.data?.skipped_entities !== 0
      || globCollectionResult.data?.radius !== 8
      || globCollectionResult.data?.selection !== "item_id_glob"
      || "failure_type" in globCollectionResult.data
      || removedNearTrack.track !== null
      || farEntityOutput.includes("No entity was found")) {
    throw new Error(`Glob collection violated Track removal or default radius 8: ${JSON.stringify({ globCollectionResult, removedNearTrack, farEntityOutput })}`);
  }
  await command(`kill @e[tag=${collectFarTag}]`);

  const ironBefore = new Set((await client.entityList({
    dimension,
    entityIdGlob: "minecraft:item",
    itemIdGlob: "minecraft:iron_ingot",
  })).tracks.map((track) => track.uuid));
  await command(`summon minecraft:item ${arenaX + 2.5} ${arenaY} ${arenaZ + 0.5} {Item:{id:\"minecraft:iron_ingot\",count:2},PickupDelay:32767s,NoGravity:1b,Tags:[\"${collectExactTag}\"]}`);
  let exactIron;
  const ironDeadline = Date.now() + 15_000;
  while (Date.now() < ironDeadline && !exactIron) {
    await client.observe();
    exactIron = (await client.entityList({
      dimension,
      entityIdGlob: "minecraft:item",
      itemIdGlob: "minecraft:iron_ingot",
    })).tracks.find((track) => !ironBefore.has(track.uuid) && track.state === "VISIBLE");
    if (!exactIron) await delay(50);
  }
  if (!exactIron) throw new Error("exact UUID collection item did not become VISIBLE");
  const exactCollectionCall = client.startToolCall("collect_items", {
    uuids: [exactIron.uuid],
    radius: null,
  });
  void exactCollectionCall.result.catch(() => {});
  await command(
    `data merge entity @e[tag=${collectExactTag},limit=1] {PickupDelay:0s}`);
  await command(
    `execute at bot run tp @e[tag=${collectExactTag},limit=1] ~ ~ ~`);
  const exactCollection = await Promise.race([
    exactCollectionCall.result,
    delay(30_000).then(() => { throw new Error("exact UUID collect_items timed out"); }),
  ]);
  const exactTrackAfter = await client.entityGet(exactIron.uuid);
  if (!exactCollection.success || exactCollection.data?.collected_items !== 2
      || exactCollection.data?.skipped_entities !== 0
      || exactCollection.data?.radius !== 8
      || exactCollection.data?.selection !== "uuids"
      || exactTrackAfter.track !== null) {
    throw new Error(`exact UUID collection did not collect and remove its Track: ${JSON.stringify({ exactCollection, exactTrackAfter })}`);
  }

  const goldBefore = new Set((await client.entityList({
    dimension,
    entityIdGlob: "minecraft:item",
    itemIdGlob: "minecraft:gold_ingot",
  })).tracks.map((track) => track.uuid));
  await command(`summon minecraft:item ${arenaX + 2.5} ${arenaY} ${arenaZ + 0.5} {Item:{id:\"minecraft:gold_ingot\",count:1},PickupDelay:32767s,NoGravity:1b,Tags:[\"${collectPartialLostTag}\"]}`);
  await command(`summon minecraft:item ${arenaX + 5.5} ${arenaY} ${arenaZ + 0.5} {Item:{id:\"minecraft:gold_ingot\",count:1},PickupDelay:32767s,NoGravity:1b,Tags:[\"${collectPartialSurvivorTag}\"]}`);
  const partialTargets = await waitForNewVisibleItemTracks(
    client, dimension, "minecraft:gold_ingot", goldBefore, 2,
    "partial collection fixtures",
  );
  const partialCollectionCall = client.startToolCall("collect_items", {
    uuids: null,
    item_id_glob: "minecraft:gold_ingot",
    radius: null,
  });
  void partialCollectionCall.result.catch(() => {});
  await delay(75);
  await command(`kill @e[tag=${collectPartialLostTag}]`);
  await command(
    `data merge entity @e[tag=${collectPartialSurvivorTag},limit=1] {PickupDelay:0s}`);
  await command(
    `execute at bot run tp @e[tag=${collectPartialSurvivorTag},limit=1] ~ ~ ~`);
  const partialCollection = await Promise.race([
    partialCollectionCall.result,
    delay(30_000).then(() => { throw new Error("partial collect_items timed out"); }),
  ]);
  if (!partialCollection.success
      || partialCollection.data?.collected_entities !== 1
      || partialCollection.data?.collected_items !== 1
      || partialCollection.data?.skipped_entities !== 1
      || partialCollection.data?.selection !== "item_id_glob"
      || "failure_type" in partialCollection.data) {
    throw new Error(`partial collect_items did not preserve best-effort success: ${JSON.stringify(partialCollection)}`);
  }

  const copperBefore = new Set((await client.entityList({
    dimension,
    entityIdGlob: "minecraft:item",
    itemIdGlob: "minecraft:copper_ingot",
  })).tracks.map((track) => track.uuid));
  await command(`summon minecraft:item ${arenaX + 2.5} ${arenaY} ${arenaZ + 0.5} {Item:{id:\"minecraft:copper_ingot\",count:1},PickupDelay:32767s,NoGravity:1b,Tags:[\"${collectAllLostTag}\"]}`);
  await command(`summon minecraft:item ${arenaX + 5.5} ${arenaY} ${arenaZ + 0.5} {Item:{id:\"minecraft:copper_ingot\",count:1},PickupDelay:32767s,NoGravity:1b,Tags:[\"${collectAllLostTag}\"]}`);
  const allLostTargets = await waitForNewVisibleItemTracks(
    client, dimension, "minecraft:copper_ingot", copperBefore, 2,
    "all-skipped collection fixtures",
  );
  const allLostCollectionCall = client.startToolCall("collect_items", {
    uuids: allLostTargets.map((track) => track.uuid),
    radius: null,
  });
  void allLostCollectionCall.result.catch(() => {});
  await delay(75);
  await command(`kill @e[tag=${collectAllLostTag}]`);
  const allLostCollection = await Promise.race([
    allLostCollectionCall.result,
    delay(30_000).then(() => { throw new Error("all-skipped collect_items timed out"); }),
  ]);
  if (allLostCollection.success
      || allLostCollection.data?.failure_type !== "unreachable"
      || allLostCollection.data?.collected_entities !== 0
      || allLostCollection.data?.collected_items !== 0
      || allLostCollection.data?.skipped_entities !== 2
      || allLostCollection.data?.selection !== "uuids") {
    throw new Error(`all-skipped still-known UUID collect_items did not return unreachable: ${JSON.stringify(allLostCollection)}`);
  }

  await command(`tp bot ${arenaX + 0.5} ${arenaY} ${arenaZ + 0.5} -90 0`);
  await assertBodyNear(client, { x: arenaX + 0.5, y: arenaY, z: arenaZ + 0.5 },
    "hidden collect_items fixture reset");
  await command(`fill ${arenaX + 4} ${arenaY} ${arenaZ - 10} ${arenaX + 4} ${arenaY + 5} ${arenaZ + 10} stone`);
  const emeraldBefore = new Set((await client.entityList({
    dimension,
    entityIdGlob: "minecraft:item",
    itemIdGlob: "minecraft:emerald",
  })).tracks.map((track) => track.uuid));
  await command(`summon minecraft:item ${arenaX + 6.5} ${arenaY} ${arenaZ + 0.5} {Item:{id:\"minecraft:emerald\",count:1},PickupDelay:32767s,NoGravity:1b,Tags:[\"${collectHiddenTag}\"]}`);
  for (let attempt = 0; attempt < 3; attempt += 1) await client.observe();
  const hiddenEmeraldTracks = (await client.entityList({
    dimension,
    entityIdGlob: "minecraft:item",
    itemIdGlob: "minecraft:emerald",
  })).tracks.filter((track) => !emeraldBefore.has(track.uuid));
  const hiddenCollection = await client.toolCall("collect_items", {
    uuids: null,
    item_id_glob: "minecraft:emerald",
    radius: null,
  });
  const hiddenEntityOutput = await command(
    `data get entity @e[tag=${collectHiddenTag},limit=1] UUID`);
  if (hiddenEmeraldTracks.length !== 0 || hiddenCollection.success
      || hiddenCollection.data?.failure_type !== "unknown_not_known"
      || hiddenEntityOutput.includes("No entity was found")) {
    throw new Error(`collect_items discovered a never-observed hidden drop: ${JSON.stringify({ hiddenEmeraldTracks, hiddenCollection, hiddenEntityOutput })}`);
  }
  const invalidSelection = await client.toolCall("collect_items", {
    uuids: [randomUUID()],
    item_id_glob: "minecraft:emerald",
    radius: 16,
  });
  const invalidRadius = await client.toolCall("collect_items", {
    uuids: null,
    item_id_glob: "minecraft:emerald",
    radius: 49,
  });
  if (invalidSelection.success || !invalidSelection.message.includes("exactly one")
      || invalidRadius.success || !invalidRadius.message.includes("radius")) {
    throw new Error(`collect_items accepted an invalid selector or radius: ${JSON.stringify({ invalidSelection, invalidRadius })}`);
  }
  await command(`kill @e[tag=${collectHiddenTag}]`);
  await command(`fill ${arenaX + 4} ${arenaY} ${arenaZ - 10} ${arenaX + 4} ${arenaY + 5} ${arenaZ + 10} air`);

  console.log("smoke: knowledge-bound attack through TypeScript SDK");
  const attackVisibleTag = "mcagent_sdk_attack_visible";
  const attackKnownTag = "mcagent_sdk_attack_known";
  const attackHiddenTag = "mcagent_sdk_attack_hidden";
  const attackMultiTag = "mcagent_sdk_attack_multi";
  const attackSplitTag = "mcagent_sdk_attack_split";
  const attackSplitChildTag = "mcagent_sdk_attack_split_child";
  const attackRangedTag = "mcagent_sdk_attack_ranged";
  const attackCrystalTag = "mcagent_sdk_attack_crystal";
  const attackDropTag = "mcagent_sdk_attack_drop";
  await command(`kill @e[tag=${attackVisibleTag}]`);
  await command(`kill @e[tag=${attackKnownTag}]`);
  await command(`kill @e[tag=${attackHiddenTag}]`);
  await command(`kill @e[tag=${attackMultiTag}]`);
  await command(`kill @e[tag=${attackSplitTag}]`);
  await command(`kill @e[tag=${attackRangedTag}]`);
  await command(`kill @e[tag=${attackCrystalTag}]`);
  await command(`kill @e[tag=${attackDropTag}]`);
  await command(`tp bot ${arenaX + 0.5} ${arenaY} ${arenaZ + 0.5} -90 0`);
  await command(
    `summon minecraft:sheep ${arenaX + 3.5} ${arenaY} ${arenaZ + 0.5} {NoAI:1b,Health:2.0f,Tags:["${attackVisibleTag}"]}`);
  let attackVisible;
  for (let attempt = 0; attempt < 100 && !attackVisible; attempt += 1) {
    await client.observe();
    attackVisible = (await client.entityList({
      dimension,
      entityIdGlob: "minecraft:sheep",
    })).tracks.find((track) => track.state === "VISIBLE"
      && Math.abs(track.position.x - (arenaX + 3.5)) < 1);
  }
  if (!attackVisible) throw new Error("explicit attack fixture never became VISIBLE");
  const visibleAttack = await Promise.race([
    client.toolCall("attack", { uuids: [attackVisible.uuid] }),
    delay(30_000).then(() => { throw new Error("VISIBLE UUID attack timed out"); }),
  ]);
  const visibleEntityAfter = await command(
    `data get entity @e[tag=${attackVisibleTag},limit=1] UUID`);
  const visibleTrackAfter = await client.entityGet(attackVisible.uuid);
  if (!visibleAttack.success || !visibleEntityAfter.includes("No entity was found")
      || visibleTrackAfter.track !== null) {
    throw new Error(`VISIBLE UUID attack did not defeat and remove the exact Track: ${JSON.stringify({ visibleAttack, visibleEntityAfter, visibleTrackAfter })}`);
  }

  const attackFixtureOrigin = {
    x: arenaX + 0.5,
    y: arenaY,
    z: arenaZ + 0.5,
  };
  await command(
    `tp bot ${attackFixtureOrigin.x} ${attackFixtureOrigin.y} ${attackFixtureOrigin.z} -90 0`);
  await assertBodyNear(client, attackFixtureOrigin, "KNOWN attack fixture reset");

  await command(
    `summon minecraft:cow ${arenaX + 3.5} ${arenaY} ${arenaZ + 0.5} {NoAI:1b,Health:2.0f,Tags:["${attackKnownTag}"]}`);
  let attackKnown;
  for (let attempt = 0; attempt < 100 && !attackKnown; attempt += 1) {
    await client.observe();
    attackKnown = (await client.entityList({
      dimension,
      entityIdGlob: "minecraft:cow",
    })).tracks.find((track) => track.state === "VISIBLE"
      && Math.abs(track.position.x - (arenaX + 3.5)) < 1);
  }
  if (!attackKnown) throw new Error("KNOWN attack fixture never became VISIBLE first");
  const attackFrozen = { ...attackKnown.position };
  await command(`fill ${arenaX + 4} ${arenaY} ${arenaZ - 10} ${arenaX + 4} ${arenaY + 5} ${arenaZ + 10} stone`);
  await command(`tp @e[tag=${attackKnownTag},limit=1] ${arenaX + 7.5} ${arenaY} ${arenaZ + 0.5}`);
  await waitForEntityTrack(client, attackKnown.uuid, "KNOWN");
  let knownAttackSettled = false;
  const knownAttackCall = client.startToolCall("attack", { uuids: [attackKnown.uuid] });
  void knownAttackCall.result.then(
    () => { knownAttackSettled = true; },
    () => { knownAttackSettled = true; },
  );
  await delay(300);
  const hiddenHealth = await command(
    `data get entity @e[tag=${attackKnownTag},limit=1] Health`);
  const frozenTrack = await client.entityGet(attackKnown.uuid);
  if (knownAttackSettled || !hiddenHealth.includes("2.0f")
      || frozenTrack.track?.state !== "KNOWN"
      || ["x", "y", "z"].some((axis) => frozenTrack.track.position[axis] !== attackFrozen[axis])) {
    throw new Error(`attack used hidden live authority: ${JSON.stringify({ knownAttackSettled, hiddenHealth, frozenTrack })}`);
  }
  await command(`fill ${arenaX + 4} ${arenaY} ${arenaZ - 10} ${arenaX + 4} ${arenaY + 5} ${arenaZ + 10} air`);
  await command(`tp @e[tag=${attackKnownTag},limit=1] ${attackFrozen.x} ${attackFrozen.y} ${attackFrozen.z}`);
  await waitForEntityTrack(client, attackKnown.uuid, "VISIBLE");
  const knownAttack = await Promise.race([
    knownAttackCall.result,
    delay(30_000).then(() => { throw new Error("KNOWN UUID attack timed out after reacquisition"); }),
  ]);
  if (!knownAttack.success) {
    throw new Error(`reacquired UUID attack failed: ${JSON.stringify(knownAttack)}`);
  }

  await command("clear bot");
  await command("give bot minecraft:diamond_sword 1");
  await command("effect give bot minecraft:strength 30 4 true");
  await command(
    `summon minecraft:sheep ${arenaX + 2.5} ${arenaY} ${arenaZ + 0.5} {NoAI:1b,Health:1.0f,Tags:["${attackMultiTag}"]}`);
  await command(
    `summon minecraft:sheep ${arenaX + 2.5} ${arenaY} ${arenaZ + 1.5} {NoAI:1b,Health:1.0f,Tags:["${attackMultiTag}"]}`);
  const multiUuids = [];
  for (let attempt = 0; attempt < 100 && multiUuids.length < 2; attempt += 1) {
    await client.observe();
    multiUuids.splice(0, multiUuids.length,
      ...(await client.entityList({
        dimension,
        entityIdGlob: "minecraft:sheep",
      })).tracks.filter((track) => track.state === "VISIBLE"
        && track.position.x >= arenaX + 2 && track.position.x <= arenaX + 3)
        .map((track) => track.uuid));
  }
  if (multiUuids.length !== 2) throw new Error(`multi-target fixtures were not VISIBLE: ${JSON.stringify(multiUuids)}`);
  const multiAttack = await Promise.race([
    client.toolCall("attack", { uuids: multiUuids }),
    delay(30_000).then(() => { throw new Error("multi-target attack timed out"); }),
  ]);
  if (!multiAttack.success
      || !multiUuids.every((uuid) => multiAttack.data?.defeated_uuids?.includes(uuid))) {
    throw new Error(`explicit multi-target attack was incomplete: ${JSON.stringify({ multiUuids, multiAttack })}`);
  }

  await command("clear bot");
  await command("effect clear bot minecraft:strength");
  await command(`tp bot ${arenaX + 0.5} ${arenaY} ${arenaZ + 0.5} -90 0`);
  await command(`kill @e[tag=${attackSplitTag}]`);
  await command(
    `kill @e[type=minecraft:item,x=${arenaX - 2},y=${arenaY - 2},z=${arenaZ - 4},dx=16,dy=8,dz=8]`);
  await command(
    `summon minecraft:slime ${arenaX + 3.5} ${arenaY} ${arenaZ + 0.5} {Size:0,Health:16.0f,Invulnerable:1b,NoAI:1b,Tags:["${attackSplitTag}"]}`);
  let splitParent;
  for (let attempt = 0; attempt < 100 && !splitParent; attempt += 1) {
    await client.observe();
    splitParent = (await client.entityList({
      dimension,
      entityIdGlob: "minecraft:slime",
    })).tracks.find((track) => track.state === "VISIBLE"
      && Math.abs(track.position.x - (arenaX + 3.5)) < 1);
  }
  if (!splitParent) throw new Error("omitted-mode split fixture never became VISIBLE");
  const splitAttackCall = client.startToolCall("attack", { uuids: null });
  void splitAttackCall.result.catch(() => {});
  await delay(200);
  await command(
    // Keep the newly admitted child alive long enough for the observation refresh to
    // publish its UUID. Omitted attack still processes and defeats it immediately after
    // the proof, so this removes only the polling race, not the outcome semantics.
    `summon minecraft:slime ${arenaX + 2.5} ${arenaY} ${arenaZ + 1.5} {Size:0,Health:1.0f,Invulnerable:1b,NoAI:1b,Tags:["${attackSplitTag}","${attackSplitChildTag}"]}`);
  let splitChild;
  for (let attempt = 0; attempt < 100 && !splitChild; attempt += 1) {
    await client.observe();
    splitChild = (await client.entityList({
      dimension,
      entityIdGlob: "minecraft:slime",
    })).tracks.find((track) => track.state === "VISIBLE"
      && track.uuid !== splitParent.uuid
      && Math.abs(track.position.x - (arenaX + 2.5)) < 0.25
      && Math.abs(track.position.z - (arenaZ + 1.5)) < 0.25);
  }
  if (!splitChild) throw new Error("newly appeared split child never became VISIBLE");
  // UUID admission has been established. Keep the terminal check away from the
  // edge of melee reach after collisions/pickups; pursuit is covered separately.
  const terminalPose = (await client.toolCall("get_self_status", {})).data.position;
  await command(`tp ${splitParent.uuid} ${terminalPose.x + 1.5} ${terminalPose.y} ${terminalPose.z - 0.5}`);
  await command(`tp ${splitChild.uuid} ${terminalPose.x + 1.5} ${terminalPose.y} ${terminalPose.z + 0.5}`);
  await client.observe();
  await command("effect give bot minecraft:strength 30 4 true");
  await command(
    `execute as @e[tag=${attackSplitTag}] run data merge entity @s {Invulnerable:0b}`);
  const splitTimeout = Symbol("split-timeout");
  let splitTimeoutId;
  let splitAttack;
  try {
    splitAttack = await Promise.race([
      splitAttackCall.result,
      new Promise((resolve) => {
        splitTimeoutId = setTimeout(() => resolve(splitTimeout), 45_000);
      }),
    ]);
  } finally {
    clearTimeout(splitTimeoutId);
  }
  if (splitAttack === splitTimeout) {
    const boundedDiagnostic = async (operation) => await Promise.race([
      operation.catch((error) => String(error)),
      delay(2_000).then(() => "diagnostic timed out"),
    ]);
      const [parentHealth, childHealth, parentTrack, childTrack, self] = await Promise.all([
        boundedDiagnostic(command(`data get entity @e[tag=${attackSplitTag},tag=!${attackSplitChildTag},limit=1] Health`)),
        boundedDiagnostic(command(`data get entity @e[tag=${attackSplitChildTag},limit=1] Health`)),
        boundedDiagnostic(client.entityGet(splitParent.uuid)),
        boundedDiagnostic(client.entityGet(splitChild.uuid)),
        boundedDiagnostic(client.toolCall("get_self_status", {})),
      ]);
      throw new Error(`omitted split attack timed out: ${JSON.stringify({
        attack_pending: true, parentHealth, childHealth, parentTrack, childTrack, self,
      })}`);
  }
  // New contract: the child appeared after task start, so it is NOT admitted.
  // The task should complete with only the parent defeated; the child survives.
  if (!splitAttack.success
      || !splitAttack.data?.defeated_uuids?.includes(splitParent.uuid)
      || splitAttack.data?.defeated_uuids?.includes(splitChild.uuid)
      || splitAttack.data?.completion !== "all") {
    throw new Error(`omitted attack admitted newly appeared split UUID: ${JSON.stringify({ splitParent, splitChild, splitAttack })}`);
  }
  const childAfter = await command(
    `data get entity @e[tag=${attackSplitChildTag},limit=1] Health`);
  if (childAfter.includes("No entity was found")) {
    throw new Error(`split child was defeated despite not being authorized: ${JSON.stringify({ splitParent, splitChild, splitAttack })}`);
  }
  await command("effect clear bot minecraft:strength");
  await command(
    `kill @e[type=minecraft:slime,x=${arenaX - 2},y=${arenaY - 2},z=${arenaZ - 4},dx=16,dy=8,dz=8]`);
  await command(
    `kill @e[type=minecraft:item,x=${arenaX - 2},y=${arenaY - 2},z=${arenaZ - 4},dx=16,dy=8,dz=8]`);

  await command("clear bot");
  await command("give bot minecraft:bow 1");
  await command("give bot minecraft:arrow 16");
  await command(`tp bot ${arenaX + 0.5} ${arenaY} ${arenaZ + 0.5} -90 0`);
  await command(
    `fill ${arenaX + 14} ${arenaY - 2} ${arenaZ - 2} ${arenaX + 44} ${arenaY + 6} ${arenaZ + 2} air`);
  await command(
    `fill ${arenaX + 14} ${arenaY - 1} ${arenaZ - 2} ${arenaX + 44} ${arenaY - 1} ${arenaZ + 2} stone`);
  await command(
    `summon minecraft:ghast ${arenaX + 20.5} ${arenaY} ${arenaZ + 0.5} {NoAI:1b,Health:2.0f,Tags:["${attackRangedTag}"]}`);
  let rangedTarget;
  for (let attempt = 0; attempt < 100 && !rangedTarget; attempt += 1) {
    await client.observe();
    rangedTarget = (await client.entityList({
      dimension,
      entityIdGlob: "minecraft:ghast",
    })).tracks.find((track) => track.state === "VISIBLE"
      && Math.abs(track.position.x - (arenaX + 20.5)) < 1);
  }
  if (!rangedTarget) throw new Error("ranged attack fixture never became VISIBLE");
  const rangedAttack = await Promise.race([
    client.toolCall("attack", { uuids: [rangedTarget.uuid] }),
    delay(60_000).then(() => { throw new Error("far ranged attack timed out"); }),
  ]);
  const rangedTrackAfter = await client.entityGet(rangedTarget.uuid);
  if (!rangedAttack.success || rangedTrackAfter.track !== null
      || !rangedAttack.data?.defeated_uuids?.includes(rangedTarget.uuid)) {
    throw new Error(`projectile death was not Actor-attributed: ${JSON.stringify({ rangedTarget, rangedAttack, rangedTrackAfter })}`);
  }

  await command("effect clear bot");
  await command("effect give bot minecraft:instant_health 1 10 true");
  await command("give bot minecraft:arrow 16");
  await command(`tp bot ${arenaX + 0.5} ${arenaY} ${arenaZ + 0.5} -90 0`);
  await command(
    `summon minecraft:end_crystal ${arenaX + 10.5} ${arenaY} ${arenaZ + 0.5} {Tags:["${attackCrystalTag}"]}`);
  let crystalTarget;
  for (let attempt = 0; attempt < 100 && !crystalTarget; attempt += 1) {
    await client.observe();
    crystalTarget = (await client.entityList({
      dimension,
      entityIdGlob: "minecraft:end_crystal",
    })).tracks.find((track) => track.state === "VISIBLE"
      && Math.abs(track.position.x - (arenaX + 10.5)) < 1);
  }
  if (!crystalTarget || "health" in crystalTarget || "max_health" in crystalTarget) {
    throw new Error(`non-living crystal fixture was not represented correctly: ${JSON.stringify(crystalTarget)}`);
  }
  const crystalStart = await client.toolCall("get_self_status", {});
  const arrowsBeforeCrystal = await matchingItemCount("bot", "minecraft:arrow");
  const crystalAttackCall = client.startToolCall("attack", { uuids: [crystalTarget.uuid] });
  void crystalAttackCall.result.catch(() => {});
  let crystalReleasePosition;
  const releaseDeadline = Date.now() + 45_000;
  while (!crystalReleasePosition && Date.now() < releaseDeadline) {
    const currentArrows = await matchingItemCount("bot", "minecraft:arrow");
    if (currentArrows < arrowsBeforeCrystal) {
      crystalReleasePosition = await entityPosition(command, "bot");
      break;
    }
    await delay(20);
  }
  const crystalAttack = await Promise.race([
    crystalAttackCall.result,
    delay(45_000).then(() => { throw new Error("end-crystal attack timed out"); }),
  ]);
  const crystalEnd = await client.toolCall("get_self_status", {});
  const arrowsAfterCrystal = await matchingItemCount("bot", "minecraft:arrow");
  const crystalReleaseDistance = crystalReleasePosition && Math.hypot(
    crystalReleasePosition.x - crystalTarget.position.x,
    crystalReleasePosition.z - crystalTarget.position.z,
  );
  if (!crystalAttack.success
      || !crystalAttack.data?.defeated_uuids?.includes(crystalTarget.uuid)
      || arrowsBeforeCrystal < 1
      || arrowsAfterCrystal >= arrowsBeforeCrystal
      || !Number.isFinite(crystalReleaseDistance)
      || crystalReleaseDistance < 12
      || crystalEnd.data?.hp !== crystalStart.data?.hp) {
    throw new Error(`end-crystal attack did not preserve the ranged blast spacing: ${JSON.stringify({
      crystalTarget, crystalAttack, crystalStart, crystalEnd,
      arrowsBeforeCrystal, arrowsAfterCrystal, crystalReleasePosition, crystalReleaseDistance,
    })}`);
  }

  await command("clear bot");
  await command("give bot minecraft:diamond_sword 1");
  await command("effect give bot minecraft:strength 30 4 true");
  await command(`tp bot ${arenaX + 0.5} ${arenaY} ${arenaZ + 0.5} -90 0`);
  await command(
    `summon minecraft:zombie ${arenaX + 2.5} ${arenaY} ${arenaZ + 0.5} {NoAI:1b,Health:2.0f,Tags:["${attackDropTag}"]}`);
  await command(
    `item replace entity @e[tag=${attackDropTag},limit=1] weapon.mainhand with minecraft:diamond 1`);
  await command(
    `data merge entity @e[tag=${attackDropTag},limit=1] {HandDropChances:[2.0f,0.0f]}`);
  const dropEquipment = await command(
    `data get entity @e[tag=${attackDropTag},limit=1] HandItems`);
  const dropChances = await command(
    `data get entity @e[tag=${attackDropTag},limit=1] HandDropChances`);
  if (!dropEquipment.includes("minecraft:diamond") || !dropChances.includes("2.0f")) {
    throw new Error(`combat-drop fixture was not equipped deterministically: ${JSON.stringify({ dropEquipment, dropChances })}`);
  }
  let dropTarget;
  for (let attempt = 0; attempt < 100 && !dropTarget; attempt += 1) {
    await client.observe();
    dropTarget = (await client.entityList({
      dimension,
      entityIdGlob: "minecraft:zombie",
    })).tracks.find((track) => track.state === "VISIBLE"
      && Math.abs(track.position.x - (arenaX + 2.5)) < 1);
  }
  if (!dropTarget) throw new Error("Actor-attributed drop fixture never became VISIBLE");
  const dropAttack = await Promise.race([
    client.toolCall("attack", { uuids: [dropTarget.uuid] }),
    delay(45_000).then(() => { throw new Error("post-combat drop attack timed out"); }),
  ]);
  if (!dropAttack.success || dropAttack.data?.completion !== "all") {
    throw new Error(`attack did not complete: ${JSON.stringify({ dropTarget, dropAttack })}`);
  }
  const observedDrops = dropAttack.data?.observed_drop_entities ?? [];
  const diamondDrop = observedDrops.find((drop) => drop.item_id === "minecraft:diamond");
  if (!diamondDrop) {
    throw new Error(`expected attributed diamond drop: ${JSON.stringify({ dropTarget, dropAttack })}`);
  }
  const dropCollect = await Promise.race([
    client.toolCall("collect_items", { uuids: [diamondDrop.uuid] }),
    delay(30_000).then(() => { throw new Error("post-combat collect timed out"); }),
  ]);
  if (!dropCollect.success) {
    throw new Error(`attributed drop was not collected: ${JSON.stringify({ diamondDrop, dropCollect })}`);
  }

  // ── Unauthorized pursuer: attack returns after the authorized target dies,
  //    without pursuing or looting nearby unauthorized hostiles. ──
  console.log("smoke: attack ignores unauthorized pursuer");
  const attackPursuerTag = "mcagent_sdk_attack_pursuer";
  const attackPursuerTargetTag = "mcagent_sdk_attack_pursuer_target";
  await command(`kill @e[tag=${attackPursuerTag}]`);
  await command(`kill @e[tag=${attackPursuerTargetTag}]`);
  await command("clear bot");
  await command("give bot minecraft:diamond_sword 1");
  await command("effect give bot minecraft:strength 30 4 true");
  await command(`tp bot ${arenaX + 0.5} ${arenaY} ${arenaZ + 0.5} -90 0`);
  await command(
    `summon minecraft:zombie ${arenaX + 2.5} ${arenaY} ${arenaZ + 0.5} {NoAI:1b,Health:2.0f,Tags:["${attackPursuerTargetTag}"]}`);
  let pursuerTarget;
  for (let attempt = 0; attempt < 100 && !pursuerTarget; attempt += 1) {
    await client.observe();
    pursuerTarget = (await client.entityList({
      dimension,
      entityIdGlob: "minecraft:zombie",
    })).tracks.find((track) => track.state === "VISIBLE"
      && Math.abs(track.position.x - (arenaX + 2.5)) < 1);
  }
  if (!pursuerTarget) throw new Error("unauthorized-pursuer target never became VISIBLE");
  const pursuerAttackCall = client.startToolCall("attack", { uuids: [pursuerTarget.uuid] });
  void pursuerAttackCall.result.catch(() => {});
  // Wait until the attack has actually struck the authorized target before spawning an
  // unauthorized zombie next to the bot. A fixed delay races the first swing, and the
  // no-AI target burning in daylight can die to fire before the bot ever swings — a
  // death that cannot be Actor-attributed. Daylight fire only ticks every 20 game ticks
  // (fire is also suppressed on the flat y=200 arena whenever the sun is down), so the
  // bot always out-races the burn; we detect the strike by the target's death and then
  // immediately summon the unauthorized zombie while the task is still settling.
  let struck = false;
  for (let attempt = 0; attempt < 100 && !struck; attempt += 1) {
    await delay(50);
    const targetGone = await command(
      `execute if entity @e[tag=${attackPursuerTargetTag},limit=1]`);
    struck = targetGone.includes("Test failed");
  }
  await command(
    `summon minecraft:zombie ${arenaX + 1.5} ${arenaY} ${arenaZ + 0.5} {NoAI:1b,Health:20.0f,Tags:["${attackPursuerTag}"]}`);
  let unauthorizedZombie;
  for (let attempt = 0; attempt < 100 && !unauthorizedZombie; attempt += 1) {
    await client.observe();
    unauthorizedZombie = (await client.entityList({
      dimension,
      entityIdGlob: "minecraft:zombie",
    })).tracks.find((track) => track.state === "VISIBLE"
      && track.uuid !== pursuerTarget.uuid
      && Math.abs(track.position.x - (arenaX + 1.5)) < 0.25);
  }
  if (!unauthorizedZombie) throw new Error("unauthorized zombie never became VISIBLE");
  const pursuerAttack = await Promise.race([
    pursuerAttackCall.result,
    delay(30_000).then(() => { throw new Error("unauthorized-pursuer attack timed out"); }),
  ]);
  if (!pursuerAttack.success
      || !pursuerAttack.data?.defeated_uuids?.includes(pursuerTarget.uuid)
      || pursuerAttack.data?.defeated_uuids?.includes(unauthorizedZombie.uuid)
      || pursuerAttack.data?.completion !== "all") {
    throw new Error(`attack pursued unauthorized zombie: ${JSON.stringify({ pursuerTarget, unauthorizedZombie, pursuerAttack })}`);
  }
  const unauthorizedAfter = await command(
    `data get entity @e[tag=${attackPursuerTag},limit=1] Health`);
  if (unauthorizedAfter.includes("No entity was found")) {
    throw new Error(`unauthorized zombie was defeated: ${JSON.stringify({ pursuerTarget, unauthorizedZombie, pursuerAttack })}`);
  }
  await command(`kill @e[tag=${attackPursuerTag}]`);
  await command(`kill @e[tag=${attackPursuerTargetTag}]`);

  await command(`kill @e[tag=${attackHiddenTag}]`);
  await command(
    `kill @e[type=minecraft:item,x=${arenaX - 2},y=${arenaY - 2},z=${arenaZ - 10},dx=48,dy=8,dz=20]`);
  await command(`tp bot ${arenaX + 0.5} ${arenaY} ${arenaZ + 0.5} -90 0`);
  await assertBodyNear(client, { x: arenaX + 0.5, y: arenaY, z: arenaZ + 0.5 },
    "hidden-hostile wall-side reset");
  await command(`fill ${arenaX + 4} ${arenaY} ${arenaZ - 10} ${arenaX + 4} ${arenaY + 5} ${arenaZ + 10} stone`);
  const wallReady = await command(
    `execute if block ${arenaX + 4} ${arenaY + 2} ${arenaZ} minecraft:stone`);
  if (!wallReady.includes("Test passed")) {
    throw new Error(`hidden-hostile wall was not installed: ${wallReady}`);
  }
  const zombieBefore = new Set((await client.entityList({
    dimension,
    entityIdGlob: "minecraft:zombie",
  })).tracks.map((track) => track.uuid));
  await command(
    `summon minecraft:zombie ${arenaX + 7.5} ${arenaY} ${arenaZ + 0.5} {NoAI:1b,Tags:["${attackHiddenTag}"]}`);
  for (let attempt = 0; attempt < 3; attempt += 1) await client.observe();
  const hiddenZombieTracks = (await client.entityList({
    dimension,
    entityIdGlob: "minecraft:zombie",
  })).tracks.filter((track) => !zombieBefore.has(track.uuid));
  const omittedAttack = await client.toolCall("attack", { uuids: null });
  const hiddenZombieAfter = await command(
    `data get entity @e[tag=${attackHiddenTag},limit=1] Health`);
  if (hiddenZombieTracks.length !== 0 || !omittedAttack.success
      || hiddenZombieAfter.includes("No entity was found")) {
    throw new Error(`omitted attack discovered a never-observed hidden hostile: ${JSON.stringify({ hiddenZombieTracks, omittedAttack, hiddenZombieAfter })}`);
  }
  await command(`kill @e[tag=${attackHiddenTag}]`);
  await command(`fill ${arenaX + 4} ${arenaY} ${arenaZ - 10} ${arenaX + 4} ${arenaY + 5} ${arenaZ + 10} air`);
  await command("clear bot");
  await command(`tp bot ${bodyPosition.x} ${bodyPosition.y} ${bodyPosition.z}`);
  await assertBodyNear(client, bodyPosition, "post-collection reset");
  await client.observe();
}
