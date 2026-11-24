/** Scaffold Material policy retains its own SDK drive and restoration oracle. */
export async function runScaffoldPolicySmoke({ client, command }) {
  console.log("smoke: World Run Scaffold Material policy through the Runtime SDK");
  const original = await client.toolCall("manage_scaffold_materials", {});
  const originalData = original.data;
  const projectionKeys = [
    "action", "item_id_globs", "effective_item_count",
    "effective_item_sample", "carried_matching_items",
  ];
  const validProjection = (result, expectedAction) => result.success
    && result.data?.action === expectedAction
    && JSON.stringify(Object.keys(result.data)) === JSON.stringify(projectionKeys)
    && Array.isArray(result.data.item_id_globs)
    && result.data.item_id_globs.length <= 16
    && Number.isInteger(result.data.effective_item_count)
    && result.data.effective_item_count >= 0
    && result.data.effective_item_count <= 128
    && Array.isArray(result.data.effective_item_sample)
    && result.data.effective_item_sample.length <= 16
    && Array.isArray(result.data.carried_matching_items);
  if (!validProjection(original, "read")
      || originalData.effective_item_count !== 23
      || originalData.item_id_globs.length > 16) {
    throw new Error(`unexpected factory Scaffold Material policy: ${JSON.stringify(original)}`);
  }

  try {
    await command("clear bot");
    await command("give bot minecraft:dirt 2");
    await command("give bot minecraft:coarse_dirt 3");
    await command("give bot minecraft:stone 4");
    await command("give bot minecraft:mud 5");

    const set = await client.toolCall("manage_scaffold_materials", {
      action: "set",
      item_id_globs: ["minecraft:*dirt", "minecraft:stone", "minecraft:*dirt"],
    });
    const carried = Object.fromEntries((set.data?.carried_matching_items ?? [])
      .map((entry) => [entry.item_id, entry.count]));
    if (!validProjection(set, "set")
        || JSON.stringify(set.data.item_id_globs) !== JSON.stringify([
          "minecraft:*dirt", "minecraft:stone",
        ])
        || set.data.effective_item_count !== 4
        || carried["minecraft:dirt"] !== 2
        || carried["minecraft:coarse_dirt"] !== 3
        || carried["minecraft:stone"] !== 4) {
      throw new Error(`Scaffold Material set was not ordered/deduplicated: ${JSON.stringify(set)}`);
    }

    const read = await client.toolCall("manage_scaffold_materials", { action: "read" });
    if (!validProjection(read, "read")
        || JSON.stringify(read.data.item_id_globs) !== JSON.stringify(set.data.item_id_globs)) {
      throw new Error(`explicit Scaffold Material read disagreed with set: ${JSON.stringify(read)}`);
    }

    const add = await client.toolCall("manage_scaffold_materials", {
      action: "add",
      item_id_globs: ["minecraft:mud", "minecraft:*dirt"],
    });
    if (!validProjection(add, "add")
        || JSON.stringify(add.data.item_id_globs) !== JSON.stringify([
          "minecraft:*dirt", "minecraft:stone", "minecraft:mud",
        ])) {
      throw new Error(`Scaffold Material add did not append/deduplicate: ${JSON.stringify(add)}`);
    }

    const exactNoOp = await client.toolCall("manage_scaffold_materials", {
      action: "delete",
      item_id_globs: ["minecraft:coarse_dirt"],
    });
    if (!validProjection(exactNoOp, "delete")
        || JSON.stringify(exactNoOp.data.item_id_globs) !== JSON.stringify(add.data.item_id_globs)) {
      throw new Error(`Scaffold Material delete expanded instead of comparing exactly: ${JSON.stringify(exactNoOp)}`);
    }

    const deleted = await client.toolCall("manage_scaffold_materials", {
      action: "delete",
      item_id_globs: ["minecraft:stone"],
    });
    const expectedAfterDelete = ["minecraft:*dirt", "minecraft:mud"];
    if (!validProjection(deleted, "delete")
        || JSON.stringify(deleted.data.item_id_globs) !== JSON.stringify(expectedAfterDelete)) {
      throw new Error(`Scaffold Material exact delete failed: ${JSON.stringify(deleted)}`);
    }

    const rejected = await client.toolCall("manage_scaffold_materials", {
      action: "set",
      item_id_globs: ["minecraft:stick"],
    });
    if (rejected.success
        || rejected.data?.action !== "set"
        || rejected.data?.failure_type !== "no_block_item_match"
        || JSON.stringify(Object.keys(rejected.data ?? {})) !== JSON.stringify([
          ...projectionKeys, "failure_type",
        ])
        || JSON.stringify(rejected.data?.item_id_globs) !== JSON.stringify(expectedAfterDelete)) {
      throw new Error(`invalid Scaffold Material write did not roll back atomically: ${JSON.stringify(rejected)}`);
    }

    const cleared = await client.toolCall("manage_scaffold_materials", { action: "clear" });
    if (!validProjection(cleared, "clear")
        || cleared.data.item_id_globs.length !== 0
        || cleared.data.effective_item_count !== 0
        || cleared.data.carried_matching_items.length !== 0) {
      throw new Error(`Scaffold Material clear did not prohibit consumption: ${JSON.stringify(cleared)}`);
    }

    const restored = await client.toolCall("manage_scaffold_materials", {
      action: "set",
      item_id_globs: originalData.item_id_globs,
    });
    if (!validProjection(restored, "set")
        || JSON.stringify(restored.data.item_id_globs) !== JSON.stringify(originalData.item_id_globs)
        || restored.data.effective_item_count !== originalData.effective_item_count) {
      throw new Error(`Scaffold Material factory policy was not restored: ${JSON.stringify(restored)}`);
    }
  } finally {
    if (Array.isArray(originalData?.item_id_globs)) {
      await client.toolCall("manage_scaffold_materials", {
        action: "set", item_id_globs: originalData.item_id_globs,
      }).catch(() => {});
    }
    await command("clear bot").catch(() => {});
  }
}
