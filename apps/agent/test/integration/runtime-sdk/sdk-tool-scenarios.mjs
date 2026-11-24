import { setTimeout as delay } from "node:timers/promises";
import { RuntimeAdapter } from "../../../dist/harness/runtime-adapter.js";

/**
 * Focused Runtime SDK tool-surface scenarios. The caller supplies the already
 * established smoke context; these functions retain scenario fixtures/oracles.
 */
export function createRuntimeSdkToolScenarios({
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
}) {
  const runInventorySmoke = async () => {
  console.log("smoke: Inventory Runtime Tools through TypeScript SDK");
  await runtimeCommand(runtime, "clear bot");
  await runtimeCommand(runtime, "give bot minecraft:iron_helmet 1");
  const helmetBefore = await matchingItemCount(runtime, "bot", "minecraft:iron_helmet");
  const equipped = await client.toolCall("equip_item", {
    action: "equip",
    item_id: "minecraft:iron_helmet",
    slot: null,
  });
  const equippedStatus = await client.toolCall("get_self_status", {});
  const helmetAfter = await matchingItemCount(runtime, "bot", "minecraft:iron_helmet");
  if (!equipped.success || equipped.data?.slot !== "head"
      || equippedStatus.data?.equipment?.head?.item !== "minecraft:iron_helmet"
      || helmetBefore !== 1 || helmetAfter !== 1) {
    throw new Error(`equip_item did not preserve the equipment semantics: ${JSON.stringify({ equipped, equippedStatus, helmetBefore, helmetAfter })}`);
  }

  await runtimeCommand(runtime, "clear bot");
  for (let slot = 0; slot < 9; slot += 1) {
    await runtimeCommand(runtime,
      `item replace entity bot hotbar.${slot} with minecraft:dirt 64`);
  }
  for (let slot = 0; slot < 27; slot += 1) {
    await runtimeCommand(runtime,
      `item replace entity bot inventory.${slot} with minecraft:dirt 64`);
  }
  await runtimeCommand(runtime,
    "item replace entity bot weapon.offhand with minecraft:shield 1");
  await runtimeCommand(runtime,
    "item replace entity bot armor.head with minecraft:iron_sword 1");
  const shieldBefore = new Set((await client.entityList({
    dimension: selfStatus.data.dimension,
    entityIdGlob: "minecraft:item",
    itemIdGlob: "minecraft:shield",
  })).tracks.map((track) => track.uuid));
  const overflowEquip = await client.toolCall("equip_item", {
    action: "equip",
    item_id: "minecraft:iron_sword",
    slot: "offhand",
  });
  const overflowShield = (await client.entityList({
    dimension: selfStatus.data.dimension,
    entityIdGlob: "minecraft:item",
    itemIdGlob: "minecraft:shield",
  })).tracks.find((track) => !shieldBefore.has(track.uuid));
  if (!overflowEquip.success || overflowEquip.data?.slot !== "offhand"
      || overflowShield?.item_count !== 1) {
    throw new Error(`equip_item overflow drop was not exactly attributed: ${JSON.stringify({ overflowEquip, overflowShield })}`);
  }
  await runtimeCommand(runtime, "clear bot");

  await runtimeCommand(runtime, "effect give bot minecraft:hunger 60 255 true");
  let hungryStatus;
  const hungerDeadline = Date.now() + 35_000;
  while (Date.now() < hungerDeadline) {
    hungryStatus = await client.toolCall("get_self_status", {});
    if (hungryStatus.data?.hunger <= 16) break;
    await delay(100);
  }
  await runtimeCommand(runtime, "effect clear bot minecraft:hunger");
  if (hungryStatus?.data?.hunger > 16) {
    throw new Error(`could not establish deterministic hunger fixture: ${JSON.stringify(hungryStatus)}`);
  }
  await runtimeCommand(runtime, "give bot minecraft:bread 2");
  const breadBefore = await matchingItemCount(runtime, "bot", "minecraft:bread");
  let eatSettled = false;
  const eating = client.startToolCall("eat", { item_id: "minecraft:bread" });
  eating.result.finally(() => { eatSettled = true; });
  await delay(300);
  const busyDrop = await client.toolCall("drop_items", {
    item_id: "minecraft:bread",
    count: 1,
  });
  const breadWhileEating = await matchingItemCount(runtime, "bot", "minecraft:bread");
  if (eatSettled || busyDrop.success || busyDrop.failure_type !== "busy"
      || breadWhileEating !== breadBefore) {
    throw new Error(`eat did not retain vanilla duration or body busy semantics: ${JSON.stringify({ eatSettled, busyDrop, breadBefore, breadWhileEating })}`);
  }
  const eaten = await Promise.race([
    eating.result,
    delay(15_000).then(() => { throw new Error("eat timed out"); }),
  ]);
  const breadAfterEat = await matchingItemCount(runtime, "bot", "minecraft:bread");
  const fedStatus = await client.toolCall("get_self_status", {});
  if (!eaten.success || breadAfterEat !== breadBefore - 1
      || fedStatus.data?.hunger <= hungryStatus.data.hunger) {
    throw new Error(`eat did not apply native consumption and Inventory delta: ${JSON.stringify({ eaten, hungryStatus, fedStatus, breadBefore, breadAfterEat })}`);
  }

  await runtimeCommand(runtime, "effect give bot minecraft:hunger 60 255 true");
  const cancelHungerDeadline = Date.now() + 35_000;
  while (Date.now() < cancelHungerDeadline) {
    const status = await client.toolCall("get_self_status", {});
    if (status.data?.hunger <= 16) break;
    await delay(100);
  }
  await runtimeCommand(runtime, "effect clear bot minecraft:hunger");
  const breadBeforeCancel = await matchingItemCount(runtime, "bot", "minecraft:bread");
  const cancelEating = client.startToolCall("eat", { item_id: "minecraft:bread" });
  await delay(200);
  const eatCancel = await client.taskCancel(cancelEating.taskId);
  const canceledEat = await cancelEating.result;
  const breadAfterCancel = await matchingItemCount(runtime, "bot", "minecraft:bread");
  if (!eatCancel.cancelled || canceledEat.success || canceledEat.interrupted !== true
      || breadAfterCancel !== breadBeforeCancel) {
    throw new Error(`eat cancellation did not use ordinary TaskResult/input cleanup: ${JSON.stringify({ eatCancel, canceledEat, breadBeforeCancel, breadAfterCancel })}`);
  }
  const eatAfterCancel = await client.toolCall("eat", { item_id: "minecraft:bread" });
  const breadAfterCleanupEat = await matchingItemCount(runtime, "bot", "minecraft:bread");
  if (!eatAfterCancel.success || breadAfterCleanupEat !== breadAfterCancel - 1) {
    throw new Error(`eat cancellation left the native use input occupied: ${JSON.stringify({ eatAfterCancel, breadAfterCancel, breadAfterCleanupEat })}`);
  }

  await runtimeCommand(runtime, "clear bot");
  await runtimeCommand(runtime, "item replace entity bot hotbar.0 with minecraft:honey_bottle 2");
  await runtimeCommand(runtime, "effect give bot minecraft:hunger 3 255 true");
  const honeyHungerDeadline = Date.now() + 15_000;
  while (Date.now() < honeyHungerDeadline) {
    const status = await client.toolCall("get_self_status", {});
    if (status.data?.hunger < 20) break;
    await delay(100);
  }
  await runtimeCommand(runtime, "effect clear bot minecraft:hunger");
  const honey = await client.toolCall("eat", { item_id: "minecraft:honey_bottle" });
  const remainingHoney = await matchingItemCount(runtime, "bot", "minecraft:honey_bottle");
  const returnedBottles = await matchingItemCount(runtime, "bot", "minecraft:glass_bottle");
  if (!honey.success || honey.data?.consumed_count !== 1
      || honey.data?.returned_container?.item_id !== "minecraft:glass_bottle"
      || honey.data?.returned_container?.count !== 1
      || remainingHoney !== 1 || returnedBottles !== 1) {
    throw new Error(`stacked honey did not retain one item and return one container: ${JSON.stringify({ honey, remainingHoney, returnedBottles })}`);
  }

  await runtimeCommand(runtime,
    `kill @e[type=minecraft:item,x=${bodyX - 8},y=${bodyY - 4},z=${bodyZ - 8},dx=16,dy=10,dz=16]`);
  await client.observe();
  const cobbleBefore = new Set((await client.entityList({
    dimension: selfStatus.data.dimension,
    entityIdGlob: "minecraft:item",
    itemIdGlob: "minecraft:cobblestone",
  })).tracks.map((track) => track.uuid));
  await runtimeCommand(runtime,
    `summon minecraft:item ${bodyPosition.x} ${bodyPosition.y + 2} ${bodyPosition.z} {Item:{id:"minecraft:cobblestone",count:1},PickupDelay:32767s,NoGravity:1b}`);
  let preexistingCobble;
  const cobbleVisibleDeadline = Date.now() + 15_000;
  while (Date.now() < cobbleVisibleDeadline && !preexistingCobble) {
    await client.observe();
    preexistingCobble = (await client.entityList({
      dimension: selfStatus.data.dimension,
      entityIdGlob: "minecraft:item",
      itemIdGlob: "minecraft:cobblestone",
    })).tracks.find((track) => !cobbleBefore.has(track.uuid) && track.state === "VISIBLE");
    if (!preexistingCobble) await delay(50);
  }
  if (!preexistingCobble) throw new Error("preexisting same-type drop never became VISIBLE");
  await runtimeCommand(runtime, "give bot minecraft:cobblestone 5");
  const inventoryBeforeDrop = await matchingItemCount(runtime, "bot", "minecraft:cobblestone");
  const dropped = await client.toolCall("drop_items", {
    item_id: "minecraft:cobblestone",
    count: 3,
  });
  const inventoryAfterDrop = await matchingItemCount(runtime, "bot", "minecraft:cobblestone");
  const droppedUuids = dropped.data?.dropped_entity_uuids;
  const droppedTrack = Array.isArray(droppedUuids) && droppedUuids.length === 1
    ? (await client.entityGet(droppedUuids[0])).track : null;
  const preexistingAfterDrop = await client.entityGet(preexistingCobble.uuid);
  if (!dropped.success || dropped.data?.dropped !== 3
      || inventoryBeforeDrop !== 5 || inventoryAfterDrop !== 2
      || !droppedTrack || droppedTrack.item_id !== "minecraft:cobblestone"
      || droppedTrack.item_count !== 3
      || droppedUuids.includes(preexistingCobble.uuid)
      || preexistingAfterDrop.track?.source === "attributable_action") {
    throw new Error(`drop_items did not preserve exact quantity/UUID attribution: ${JSON.stringify({ dropped, droppedTrack, preexistingCobble, preexistingAfterDrop, inventoryBeforeDrop, inventoryAfterDrop })}`);
  }
  await runtimeCommand(runtime, "clear bot");
  await runtimeCommand(runtime, "effect give bot minecraft:saturation 1 255 true");
  await delay(250);
  const restoredStatus = await client.toolCall("get_self_status", {});
  if (restoredStatus.data?.hunger !== 20) {
    throw new Error(`Inventory fixture did not restore hunger for later smoke stages: ${JSON.stringify(restoredStatus)}`);
  }
  };

  const runDeathRespawnSmoke = async (controlClient) => {
    console.log("smoke: active TaskResult death termination and same-World-Run respawn");
    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, "effect give bot minecraft:hunger 5 255 true");
    const hungerDeadline = Date.now() + 35_000;
    let hungryStatus;
    while (Date.now() < hungerDeadline) {
      hungryStatus = await controlClient.toolCall("get_self_status", {});
      if (hungryStatus.data?.hunger <= 16) break;
      await delay(100);
    }
    await runtimeCommand(runtime, "effect clear bot minecraft:hunger");
    if (hungryStatus?.data?.hunger > 16) {
      throw new Error(`death fixture did not make the Runtime Bot hungry: ${JSON.stringify(hungryStatus)}`);
    }
    await runtimeCommand(runtime, "give bot minecraft:bread 1");
    const activeEat = controlClient.startToolCall("eat", { item_id: "minecraft:bread" });
    await delay(100);
    const busy = await controlClient.toolCall("goto", { goal: { kind: "elevation", y: bodyY + 20 } });
    if (busy.success || busy.failure_type !== "busy") {
      throw new Error(`death fixture did not establish an active body task: ${JSON.stringify(busy)}`);
    }
    await runtimeCommand(runtime, "kill bot");
    const deathResult = await Promise.race([
      activeEat.result,
      delay(10_000).then(() => {
        throw new Error("death did not terminate the pending Runtime TaskResult");
      }),
    ]);
    if (deathResult.success || deathResult.interrupted !== true
        || deathResult.data?.consumed_count !== 0
        || deathResult.data?.returned_container !== undefined) {
      throw new Error(`death did not interrupt the active Runtime TaskResult: ${JSON.stringify(deathResult)}`);
    }
    let resetActor;
    let sawResetLifecycle = false;
    const resetDeadline = Date.now() + 15_000;
    while (Date.now() < resetDeadline) {
      resetActor = await controlClient.actorGet();
      if (resetActor.lifecycle_state !== "alive") sawResetLifecycle = true;
      if (sawResetLifecycle && resetActor.lifecycle_state === "alive") break;
      await delay(50);
    }
    if (!sawResetLifecycle || resetActor?.lifecycle_state !== "alive"
        || resetActor.uuid !== actor.uuid) {
      throw new Error(`vanilla respawn did not preserve the World Run actor: ${JSON.stringify({ actor, resetActor })}`);
    }
    const respawnInfo = await controlClient.runtimeInfo();
    if (respawnInfo.readiness !== "ready"
        || respawnInfo.world_knowledge_profile !== expectedWorldKnowledgeProfile) {
      throw new Error(`runtime.info did not return to ready after respawn: ${JSON.stringify(respawnInfo)}`);
    }

    // Native completion must retain both the consumed potion and its lethal
    // effect even though death interrupts the surrounding body Task.
    await delay(3_500);
    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, "effect give bot minecraft:instant_health 1 5 true");
    await delay(100);
    await runtimeCommand(runtime, "effect clear bot");
    await runtimeCommand(runtime,
      'item replace entity bot hotbar.0 with minecraft:potion[minecraft:potion_contents={potion:"minecraft:strong_harming"}]');
    await runtimeCommand(runtime, "damage bot 19 minecraft:generic_kill");
    const oneHp = await controlClient.toolCall("get_self_status", {});
    if (oneHp.data?.hp !== 1) {
      throw new Error(`fatal potion fixture did not establish one HP: ${JSON.stringify(oneHp)}`);
    }
    const fatalPotion = await Promise.race([
      controlClient.toolCall("eat", { item_id: "minecraft:potion" }),
      delay(15_000).then(() => { throw new Error("fatal potion timed out"); }),
    ]);
    if (fatalPotion.success || fatalPotion.interrupted !== true
        || fatalPotion.data?.consumed_count !== 1
        || fatalPotion.data?.returned_container?.item_id !== "minecraft:glass_bottle"
        || fatalPotion.data?.hp > 0) {
      throw new Error(`fatal potion completion lost consumption or death semantics: ${JSON.stringify(fatalPotion)}`);
    }

    const fatalRespawnDeadline = Date.now() + 15_000;
    let fatalRespawn;
    while (Date.now() < fatalRespawnDeadline) {
      fatalRespawn = await controlClient.actorGet();
      if (fatalRespawn?.lifecycle_state === "alive") break;
      await delay(50);
    }
    if (fatalRespawn?.lifecycle_state !== "alive" || fatalRespawn.uuid !== actor.uuid) {
      throw new Error(`fatal potion respawn did not preserve the World Run actor: ${JSON.stringify(fatalRespawn)}`);
    }
  };

  const runMenuSmoke = async () => {
    console.log("smoke: Menu inspection and transfer through TypeScript SDK");
    const menuX = bodyX;
    const menuY = 220;
    const menuZ = bodyZ;
    const chest = { x: menuX + 1, y: menuY, z: menuZ };
    await runtimeCommand(runtime,
      `fill ${menuX - 4} ${menuY - 2} ${menuZ - 4} ${menuX + 6} ${menuY + 5} ${menuZ + 4} air`);
    await runtimeCommand(runtime,
      `fill ${menuX - 4} ${menuY - 1} ${menuZ - 4} ${menuX + 6} ${menuY - 1} ${menuZ + 4} stone`);
    await runtimeCommand(runtime, `setblock ${chest.x} ${chest.y} ${chest.z} chest`);
    await runtimeCommand(runtime,
      `item replace block ${chest.x} ${chest.y} ${chest.z} container.0 with minecraft:diamond 5`);
    await runtimeCommand(runtime, `tp bot ${menuX + 0.69} ${menuY} ${menuZ + 0.5} -90 0`);
    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, "give bot minecraft:cobblestone 4");
    await assertBodyNear(client, { x: menuX + 0.69, y: menuY, z: menuZ + 0.5 },
      "Menu setup");
    await waitForBodyOnGround(client, "Menu setup");

    const closedInspect = await client.toolCall("inspect_gui", {});
    if (!closedInspect.success || closedInspect.data?.own_inventory !== true
        || closedInspect.data?.slots?.some((slot) => slot.item_id === "minecraft:diamond")) {
      throw new Error(`inspect_gui read unopened container storage: ${JSON.stringify(closedInspect)}`);
    }

    let chestEvidence;
    const chestEvidenceDeadline = Date.now() + 15_000;
    while (Date.now() < chestEvidenceDeadline) {
      await client.observe();
      chestEvidence = await client.blockGet(selfStatus.data.dimension, [chest]);
      if (chestEvidence.cells[0]?.state === "KNOWN_BLOCK") break;
      await delay(50);
    }
    if (!chestEvidence?.cells[0]?.block_state?.startsWith("minecraft:chest")) {
      throw new Error(`Menu chest did not become evidence-bound: ${JSON.stringify(chestEvidence)}`);
    }
    const opened = await activateBlockAfterSettling(client, chest, "Menu interaction");
    if (!opened.success) {
      throw new Error(`evidence-bound chest interaction failed: ${JSON.stringify(opened)}`);
    }
    const inspected = await client.toolCall("inspect_gui", {});
    const playerCobbleSlot = inspected.data?.slots?.find((slot) =>
      slot.owner === "player" && slot.item_id === "minecraft:cobblestone" && slot.count === 4)?.index;
    if (!inspected.success || inspected.data?.menu_type !== "minecraft:generic_9x3"
        || !inspected.data?.slots?.every((slot) => Number.isInteger(slot.max_stack_size)
          && slot.max_stack_size > 0)
        || !inspected.data?.slots?.some((slot) => slot.owner === "menu"
          && slot.container_slot === 0 && slot.item_id === "minecraft:diamond" && slot.count === 5)
        || !inspected.data?.slots?.some((slot) => slot.owner === "menu"
          && slot.container_slot === 1 && slot.item_id === null)
        || !Number.isInteger(playerCobbleSlot)) {
      throw new Error(`inspect_gui omitted visible Menu slots/items: ${JSON.stringify(inspected)}`);
    }

    const deposited = await client.toolCall("transfer", {
      menu_id: inspected.data.menu_id,
      menu_revision: inspected.data.menu_revision,
      moves: [{ from: playerCobbleSlot, to: 1, count: 2 }],
    });
    const afterDeposit = await client.toolCall("inspect_gui", {});
    if (!deposited.success
        || deposited.data?.menu_id !== inspected.data.menu_id
        || deposited.data?.before_revision !== inspected.data.menu_revision
        || deposited.data?.moves?.[0]?.item_id !== "minecraft:cobblestone"
        || deposited.data?.moves?.[0]?.requested_count !== 2
        || deposited.data?.moves?.[0]?.moved_count !== 2
        || deposited.data?.moves?.[0]?.outcome !== "moved"
        || !afterDeposit.data?.slots?.some((slot) => slot.owner === "menu"
          && slot.container_slot === 1 && slot.item_id === "minecraft:cobblestone" && slot.count === 2)
        || !afterDeposit.data?.slots?.some((slot) => slot.index === playerCobbleSlot
          && slot.item_id === "minecraft:cobblestone" && slot.count === 2)) {
      throw new Error(`transfer did not move the exact deposit quantity: ${JSON.stringify({ deposited, afterDeposit })}`);
    }

    const withdrew = await client.toolCall("transfer", {
      menu_id: afterDeposit.data.menu_id,
      menu_revision: afterDeposit.data.menu_revision,
      moves: [{ from: 0, to: null, count: null }],
    });
    const afterWithdraw = await client.toolCall("inspect_gui", {});
    if (!withdrew.success
        || !afterWithdraw.data?.slots?.some((slot) => slot.owner === "menu"
          && slot.container_slot === 0 && slot.item_id === null)
        || !afterWithdraw.data?.slots?.some((slot) => slot.owner === "player"
          && slot.item_id === "minecraft:diamond" && slot.count === 5)) {
      throw new Error(`transfer did not route container items to Inventory: ${JSON.stringify({ withdrew, afterWithdraw })}`);
    }

    {
      const beforeBadQuantity = await client.toolCall("inspect_gui", {});
      const badQuantity = await client.toolCall("transfer", {
        menu_id: beforeBadQuantity.data.menu_id,
        menu_revision: beforeBadQuantity.data.menu_revision,
        moves: [{ from: 1, to: playerCobbleSlot, count: 0 }],
      });
      const beforeBadSlot = await client.toolCall("inspect_gui", {});
      const badSlot = await client.toolCall("transfer", {
        menu_id: beforeBadSlot.data.menu_id,
        menu_revision: beforeBadSlot.data.menu_revision,
        moves: [{ from: 999, to: null, count: null }],
      });
      if (badQuantity.success || !badQuantity.message.includes("count must be at least 1")
          || !badSlot.success || !badSlot.message.includes("OUT OF RANGE")) {
        throw new Error(`transfer did not return stable validation results: ${JSON.stringify({ badQuantity, badSlot })}`);
      }
    }

    const closed = await client.toolCall("close_gui", {});
    const afterClose = await client.toolCall("inspect_gui", {});
    const transferWithoutMenu = await client.toolCall("transfer", {
      moves: [{ from: 0, to: null, count: null }],
    });
    const closedAgain = await client.toolCall("close_gui", {});
    const forbiddenStorage = await client.toolCall("inspect_block_storage", {});
    if (!closed.success || !afterClose.success
        || afterClose.data?.own_inventory !== true
        || transferWithoutMenu.success
        || transferWithoutMenu.failure_type !== "menu_not_open"
        || !closedAgain.success
        || forbiddenStorage.success) {
      throw new Error(`close/no-Menu/forbidden-storage semantics failed: ${JSON.stringify({ closed, afterClose, transferWithoutMenu, closedAgain, forbiddenStorage })}`);
    }

    await runtimeCommand(runtime, `setblock ${chest.x} ${chest.y} ${chest.z} furnace`);
    await runtimeCommand(runtime,
      `item replace block ${chest.x} ${chest.y} ${chest.z} container.0 with minecraft:raw_iron 1`);
    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, "give bot minecraft:coal 2");
    await runtimeCommand(runtime, "give bot minecraft:iron_ingot 1");
    let furnaceEvidence;
    const furnaceEvidenceDeadline = Date.now() + 15_000;
    while (Date.now() < furnaceEvidenceDeadline) {
      await client.observe();
      furnaceEvidence = await client.blockGet(selfStatus.data.dimension, [chest]);
      if (furnaceEvidence.cells[0]?.block_state?.startsWith("minecraft:furnace")) break;
      await delay(50);
    }
    if (!furnaceEvidence?.cells[0]?.block_state?.startsWith("minecraft:furnace")) {
      throw new Error(`Menu furnace did not become evidence-bound: ${JSON.stringify(furnaceEvidence)}`);
    }
    const openedFurnace = await activateBlockAfterSettling(client, chest, "Furnace Menu interaction");
    const adapter = new RuntimeAdapter(client);
    const coalBefore = await matchingItemCount(runtime, "bot", "minecraft:coal");
    const acceptedFuel = await adapter.semantic.transferItem({
      item_id: "minecraft:coal", count: 1,
      source: "player_inventory", target: "menu_fuel",
    });
    await delay(150);
    const afterFuel = await client.toolCall("inspect_gui", {});
    const coalAfter = await matchingItemCount(runtime, "bot", "minecraft:coal");
    const ingotBefore = await matchingItemCount(runtime, "bot", "minecraft:iron_ingot");
    const rejectedFuel = await adapter.semantic.transferItem({
      item_id: "minecraft:iron_ingot", count: 1,
      source: "player_inventory", target: "menu_fuel",
    });
    const afterRejectedFuel = await client.toolCall("inspect_gui", {});
    const ingotAfter = await matchingItemCount(runtime, "bot", "minecraft:iron_ingot");
    if (!openedFurnace.success || !acceptedFuel.ok || acceptedFuel.data?.count !== 1
        || coalBefore !== 2 || coalAfter !== 1
        || afterFuel.data?.slots?.some((slot) => slot.owner === "menu"
          && slot.container_slot === 1 && slot.item_id !== null)
        || !(afterFuel.data?.data_values?.[0] > 0)
        || rejectedFuel.ok || ingotBefore !== 1 || ingotAfter !== 1
        || !afterRejectedFuel.data?.slots?.some((slot) => slot.owner === "menu"
          && slot.container_slot === 0 && slot.item_id === "minecraft:raw_iron" && slot.count === 1)
        || afterRejectedFuel.data?.cursor?.item_id !== null) {
      throw new Error(`immediate furnace-fuel receipt/accounting failed: ${JSON.stringify({
        openedFurnace, acceptedFuel, coalBefore, coalAfter, afterFuel,
        rejectedFuel, ingotBefore, ingotAfter, afterRejectedFuel,
      })}`);
    }
    await client.toolCall("close_gui", {});
    await runSmeltAtFurnaceSmoke(runtime, client, url, chest, selfStatus.data.dimension);
    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, `tp bot ${bodyPosition.x} ${bodyPosition.y} ${bodyPosition.z}`);
    await assertBodyNear(client, bodyPosition, "post-Menu reset");
  };

  const runCraftSmoke = async () => {
    console.log("smoke: recipe lookup and crafting through TypeScript SDK");
    const craftX = bodyX;
    const craftY = 230;
    const craftZ = bodyZ;
    const table = { x: craftX + 1, y: craftY - 1, z: craftZ };
    await runtimeCommand(runtime,
      `fill ${craftX - 4} ${craftY - 2} ${craftZ - 4} ${craftX + 6} ${craftY + 5} ${craftZ + 4} air`);
    await runtimeCommand(runtime,
      `fill ${craftX - 4} ${craftY - 1} ${craftZ - 4} ${craftX + 6} ${craftY - 1} ${craftZ + 4} stone`);
    await runtimeCommand(runtime, `setblock ${table.x} ${table.y} ${table.z} crafting_table`);
    await runtimeCommand(runtime, `tp bot ${table.x + 0.5} ${craftY} ${table.z + 0.5} -90 0`);
    await runtimeCommand(runtime, "clear bot");
    await assertBodyNear(client, { x: table.x + 0.5, y: craftY, z: table.z + 0.5 },
      "Craft setup");
    await waitForBodyOnGround(client, "Craft setup");

    const lookup = await client.toolCall("lookup_recipe", {
      recipe_or_output_id_glob: "minecraft:oak_pl*",
    });
    const lookupByRecipeId = await client.toolCall("lookup_recipe", {
      recipe_or_output_id_glob: "minecraft:iron_ingot_from_smelting_iron_ore",
    });
    const globLookup = await client.toolCall("lookup_recipe", {
      recipe_or_output_id_glob: "minecraft:oak_pl?nk?",
    });
    const invalidGlob = await client.toolCall("lookup_recipe", {
      recipe_or_output_id_glob: "minecraft:(oak|birch)_planks",
    });
    if (!lookup.success || !lookup.message.includes("recipe minecraft:oak_planks")
        || !lookup.message.includes("-> minecraft:oak_planks")
        || !lookupByRecipeId.success
        || !lookupByRecipeId.message.includes("recipe minecraft:iron_ingot_from_smelting_iron_ore")
        || !lookupByRecipeId.message.includes("-> minecraft:iron_ingot")
        || !globLookup.success
        || !globLookup.message.includes("recipe minecraft:oak_planks")
        || invalidGlob.success
        || !invalidGlob.message.includes("unsupported canonical identifier glob")) {
      throw new Error(`lookup_recipe did not enforce bounded canonical recipe/output selectors: ${JSON.stringify({ lookup, lookupByRecipeId, globLookup, invalidGlob })}`);
    }

    await runtimeCommand(runtime, "give bot minecraft:oak_log 1");
    const logBefore = await matchingItemCount(runtime, "bot", "minecraft:oak_log");
    const planksBefore = await matchingItemCount(runtime, "bot", "minecraft:oak_planks");
    const craftedPlanks = await client.toolCall("craft", {
      item_id: "minecraft:oak_planks",
      count: 4,
    });
    const logAfter = await matchingItemCount(runtime, "bot", "minecraft:oak_log");
    const planksAfter = await matchingItemCount(runtime, "bot", "minecraft:oak_planks");
    if (!craftedPlanks.success || craftedPlanks.data?.crafted !== 4
        || logBefore !== 1 || logAfter !== 0
        || planksBefore !== 0 || planksAfter !== 4) {
      throw new Error(`direct 2x2 craft did not preserve vanilla Inventory deltas: ${JSON.stringify({ craftedPlanks, logBefore, logAfter, planksBefore, planksAfter })}`);
    }

    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, "give bot minecraft:cobblestone 8");
    const gated = await client.toolCall("craft", {
      item_id: "minecraft:furnace",
      count: 1,
    });
    const stillClosed = await client.toolCall("inspect_gui", {});
    if (gated.success || gated.data?.failure_type !== "needs_crafting_table"
        || !stillClosed.success || stillClosed.data?.own_inventory !== true) {
      throw new Error(`3x3 craft bypassed the already-open crafting-table Menu gate: ${JSON.stringify({ gated, stillClosed })}`);
    }

    let tableEvidence;
    const tableEvidenceDeadline = Date.now() + 15_000;
    while (Date.now() < tableEvidenceDeadline) {
      await client.observe();
      tableEvidence = await client.blockGet(selfStatus.data.dimension, [table]);
      if (tableEvidence.cells[0]?.state === "KNOWN_BLOCK") break;
      await delay(50);
    }
    if (!tableEvidence?.cells[0]?.block_state?.startsWith("minecraft:crafting_table")) {
      const craftStatus = await client.toolCall("get_self_status", {});
      const nearbyEvidence = await client.blockRegion(selfStatus.data.dimension,
        { x: table.x - 1, y: table.y - 1, z: table.z - 1 },
        { x: table.x + 1, y: table.y + 2, z: table.z + 1 });
      const physicalTable = await runtimeCommand(runtime,
        `execute if block ${table.x} ${table.y} ${table.z} minecraft:crafting_table run data get entity bot Pos`);
      throw new Error(`crafting table did not become evidence-bound: ${JSON.stringify({
        tableEvidence, craftStatus, nearbyEvidence, physicalTable,
      })}`);
    }
    const opened = await activateBlockAfterSettling(client, table, "Craft interaction");
    const openMenu = await client.toolCall("inspect_gui", {});
    if (!opened.success || opened.data?.outcome !== "menu_opened"
        || !openMenu.success || openMenu.data?.menu_type !== "minecraft:crafting") {
      throw new Error(`evidence-bound crafting-table Menu did not open: ${JSON.stringify({ opened, openMenu })}`);
    }

    const cobbleBefore = await matchingItemCount(runtime, "bot", "minecraft:cobblestone");
    const furnaceBefore = await matchingItemCount(runtime, "bot", "minecraft:furnace");
    const craftedFurnace = await client.toolCall("craft", {
      item_id: "minecraft:furnace",
      count: 1,
    });
    const cobbleAfter = await matchingItemCount(runtime, "bot", "minecraft:cobblestone");
    const furnaceAfter = await matchingItemCount(runtime, "bot", "minecraft:furnace");
    const menuAfterCraft = await client.toolCall("inspect_gui", {});
    const failedRecipe = await client.toolCall("craft", {
      item_id: "minecraft:diamond",
      count: 1,
    });
    if (!craftedFurnace.success || craftedFurnace.data?.crafted !== 1
        || cobbleBefore !== 8 || cobbleAfter !== 0
        || furnaceBefore !== 0 || furnaceAfter !== 1
        || !menuAfterCraft.success || menuAfterCraft.data?.menu_type !== "minecraft:crafting"
        || failedRecipe.success || !failedRecipe.message.includes("not enough materials")
        || !failedRecipe.message.includes("diamond_block")) {
      throw new Error(`3x3 craft or failure semantics were incorrect: ${JSON.stringify({ craftedFurnace, cobbleBefore, cobbleAfter, furnaceBefore, furnaceAfter, menuAfterCraft, failedRecipe })}`);
    }

    const closed = await client.toolCall("close_gui", {});
    if (!closed.success) throw new Error(`crafting Menu did not close: ${JSON.stringify(closed)}`);
    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, `tp bot ${bodyPosition.x} ${bodyPosition.y} ${bodyPosition.z}`);
    await assertBodyNear(client, bodyPosition, "post-Craft reset");
  };

  const runEyeSmoke = async () => {
    console.log("smoke: embodied Ender Eye through TypeScript SDK");
    const eyeX = bodyX;
    const eyeY = 240;
    const eyeZ = bodyZ;
    const chest = { x: eyeX + 2, y: eyeY, z: eyeZ };
    await runtimeCommand(runtime,
      `fill ${eyeX - 4} ${eyeY - 2} ${eyeZ - 4} ${eyeX + 6} ${eyeY + 5} ${eyeZ + 4} air`);
    await runtimeCommand(runtime,
      `fill ${eyeX - 4} ${eyeY - 1} ${eyeZ - 4} ${eyeX + 6} ${eyeY - 1} ${eyeZ + 4} stone`);
    await runtimeCommand(runtime, `setblock ${chest.x} ${chest.y} ${chest.z} chest`);
    await runtimeCommand(runtime, `tp bot ${eyeX + 0.5} ${eyeY} ${eyeZ + 0.5} -90 0`);
    await runtimeCommand(runtime, "clear bot");
    await assertBodyNear(client, { x: eyeX + 0.5, y: eyeY, z: eyeZ + 0.5 },
      "Ender Eye setup");

    const withoutEye = await client.toolCall("throw_eye_of_ender", {});
    if (withoutEye.success || !withoutEye.message.includes("no Ender Eye")) {
      throw new Error(`throw_eye_of_ender did not require an Eye: ${JSON.stringify(withoutEye)}`);
    }

    let chestEvidence;
    const chestEvidenceDeadline = Date.now() + 15_000;
    while (Date.now() < chestEvidenceDeadline) {
      await client.observe();
      chestEvidence = await client.blockGet(selfStatus.data.dimension, [chest]);
      if (chestEvidence.cells[0]?.state === "KNOWN_BLOCK") break;
      await delay(50);
    }
    const opened = await client.toolCall("activate_block", { position: chest });
    await runtimeCommand(runtime,
      "item replace entity bot inventory.0 with minecraft:ender_eye 1");
    const withMenu = await client.toolCall("throw_eye_of_ender", {});
    if (!opened.success || withMenu.success || !withMenu.message.includes("close the open menu")) {
      throw new Error(`throw_eye_of_ender did not enforce the no-Menu gate: ${JSON.stringify({ opened, withMenu })}`);
    }
    await client.toolCall("close_gui", {});

    const forbiddenTerms = [
      "target", "stronghold", "structure", "coordinate", "position", "distance",
      "trajectory", "triangulation", "navigation",
    ];
    const assertSafeResult = (result) => {
      const visit = (value) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (value === null || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          const normalized = key.toLowerCase();
          if (forbiddenTerms.some((term) => normalized.includes(term))) {
            throw new Error(`Ender Eye result exposed forbidden field ${key}: ${JSON.stringify(result)}`);
          }
          visit(child);
        }
      };
      visit(result);
    };

    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, "item replace entity bot hotbar.0 with minecraft:stick 1");
    await runtimeCommand(runtime, "item replace entity bot inventory.0 with minecraft:ender_eye 1");
    const selectedBefore = await runtimeCommand(runtime, "data get entity bot SelectedItemSlot");
    const countBefore = await matchingItemCount(runtime, "bot", "minecraft:ender_eye");
    const firstThrow = await Promise.race([
      client.toolCall("throw_eye_of_ender", {}),
      delay(15_000).then(() => { throw new Error("first Ender Eye throw timed out"); }),
    ]);
    const selectedAfter = await runtimeCommand(runtime, "data get entity bot SelectedItemSlot");
    const countAfter = await matchingItemCount(runtime, "bot", "minecraft:ender_eye");
    const magnitude = Math.hypot(
      firstThrow.data?.direction?.x,
      firstThrow.data?.direction?.y,
      firstThrow.data?.direction?.z,
    );
    assertSafeResult(firstThrow);
    if (!firstThrow.success || firstThrow.data?.consumed !== 1
        || !["dropped", "shattered"].includes(firstThrow.data?.terminal)
        || !Number.isFinite(magnitude) || Math.abs(magnitude - 1) > 1e-9
        || countBefore !== 1 || countAfter !== 0 || selectedAfter !== selectedBefore) {
      throw new Error(`Ender Eye native use/direction/slot restoration failed: ${JSON.stringify({ firstThrow, selectedBefore, selectedAfter, countBefore, countAfter, magnitude })}`);
    }

    const terminals = new Set([firstThrow.data.terminal]);
    const validateTerminal = async (result, knownBefore) => {
      assertSafeResult(result);
      const knownAfter = (await client.entityList({
        dimension: selfStatus.data.dimension,
        entityIdGlob: "minecraft:item",
        itemIdGlob: "minecraft:ender_eye",
      })).tracks;
      const newTracks = knownAfter.filter((track) => !knownBefore.has(track.uuid));
      if (result.data?.terminal === "dropped") {
        const uuid = result.data?.item_entity_uuid;
        const exact = typeof uuid === "string" ? (await client.entityGet(uuid)).track : null;
        if (!exact || exact.uuid !== uuid || exact.item_id !== "minecraft:ender_eye"
            || exact.entity_id !== "minecraft:item"
            || newTracks.length !== 1 || newTracks[0].uuid !== uuid) {
          throw new Error(`dropped Eye lacked exact attributable Entity Track: ${JSON.stringify({ result, exact, newTracks })}`);
        }
      } else if ("item_entity_uuid" in (result.data ?? {}) || newTracks.length !== 0) {
        throw new Error(`shattered Eye created a false attributable Track: ${JSON.stringify({ result, newTracks })}`);
      }
    };

    let priorTracks = new Set((await client.entityList({
      dimension: selfStatus.data.dimension,
      entityIdGlob: "minecraft:item",
      itemIdGlob: "minecraft:ender_eye",
    })).tracks
      .map((track) => track.uuid));
    await validateTerminal(firstThrow, new Set());
    priorTracks = new Set((await client.entityList({
      dimension: selfStatus.data.dimension,
      entityIdGlob: "minecraft:item",
      itemIdGlob: "minecraft:ender_eye",
    })).tracks
      .map((track) => track.uuid));

    for (let attempt = 0; terminals.size < 2 && attempt < 31; attempt += 1) {
      await runtimeCommand(runtime, "give bot minecraft:ender_eye 1");
      const result = await Promise.race([
        client.toolCall("throw_eye_of_ender", {}),
        delay(15_000).then(() => { throw new Error("repeated Ender Eye throw timed out"); }),
      ]);
      if (!result.success) {
        throw new Error(`repeated Ender Eye throw failed: ${JSON.stringify(result)}`);
      }
      await validateTerminal(result, priorTracks);
      terminals.add(result.data.terminal);
      priorTracks = new Set((await client.entityList({
        dimension: selfStatus.data.dimension,
        entityIdGlob: "minecraft:item",
        itemIdGlob: "minecraft:ender_eye",
      })).tracks
        .map((track) => track.uuid));
    }
    if (!terminals.has("dropped") || !terminals.has("shattered")) {
      throw new Error(`did not observe both vanilla Eye terminals in 32 throws: ${JSON.stringify([...terminals])}`);
    }

    await runtimeCommand(runtime, "give bot minecraft:ender_eye 1");
    const cancelBefore = await matchingItemCount(runtime, "bot", "minecraft:ender_eye");
    const cancelThrow = client.startToolCall("throw_eye_of_ender", {});
    await delay(200);
    const cancelAck = await client.taskCancel(cancelThrow.taskId);
    const canceled = await cancelThrow.result;
    const cancelAfter = await matchingItemCount(runtime, "bot", "minecraft:ender_eye");
    assertSafeResult(canceled);
    if (!cancelAck.cancelled || canceled.success || canceled.interrupted !== true
        || Object.keys(canceled.data ?? {}).length !== 0
        || "receipt" in canceled || "partial_effects" in canceled
        || cancelAfter !== cancelBefore - 1) {
      throw new Error(`Ender Eye cancellation did not use an ordinary TaskResult: ${JSON.stringify({ cancelAck, canceled, cancelBefore, cancelAfter })}`);
    }

    await runtimeCommand(runtime, "clear bot");
    await runtimeCommand(runtime, `tp bot ${bodyPosition.x} ${bodyPosition.y} ${bodyPosition.z}`);
    await assertBodyNear(client, bodyPosition, "post-Ender-Eye reset");
  };


  return {
    runInventorySmoke,
    runDeathRespawnSmoke,
    runMenuSmoke,
    runCraftSmoke,
    runEyeSmoke,
  };
}
