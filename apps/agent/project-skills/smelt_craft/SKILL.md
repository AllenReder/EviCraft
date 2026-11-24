---
schema_version: 1
name: smelt_craft
description: Use when you carry raw ore or raw food to smelt, or need an item with several crafting steps. Covers furnaces, fuel, smelt_at_furnace, craft and partial results.
---
# smelt_craft

## Smelting

- `smelt_at_furnace` works one ordinary `minecraft:furnace` that you have seen, either at an exact `position` or the nearest one within `distance` (default 32). It never finds or builds one, so first make sure a placed furnace is known.
- A furnace costs 8 cobblestone. Craft it, then put it down next to you with `place_block_nearby({ item_id: "minecraft:furnace" })`.
- One call smelts up to 16 items, about 10 seconds each. Leave out `fuel_item` and it picks carried coal or charcoal, then planks, logs or sticks. One coal or charcoal smelts 8 items, a plank or log 1.5, a stick 0.5.
- On failure, read `processed_input` and `collected_output`: finished items are kept. Retry only for what is still missing.

```ts
const known = await abilities.find_known_blocks({ block_id_glob: "minecraft:furnace" });
if (!known.ok || known.data.matches.length === 0) {
  const made = await abilities.craft({ item_id: "minecraft:furnace", count: 1 });
  console.log(made.message);
  const placed = await abilities.place_block_nearby({ item_id: "minecraft:furnace" });
  console.log(placed.message);
}
const smelted = await abilities.smelt_at_furnace({ input_item: "minecraft:raw_iron", count: 8 });
console.log(smelted.message, JSON.stringify(smelted.data));
const pickaxe = await abilities.craft({ item_id: "minecraft:iron_pickaxe", count: 1 });
console.log(pickaxe.message);
if (pickaxe.ok) console.log((await abilities.equip_item({ item_id: "minecraft:iron_pickaxe" })).message);
```

Raw iron, gold and copper smelt into ingots. Raw beef, porkchop, chicken, mutton and cod cook into food. Sand smelts into glass and logs into charcoal.

## Crafting

`craft({ item_id, count })` makes `count` new items. It uses the 2x2 grid when the recipe fits, otherwise walks to a remembered crafting table or places one, and closes the Menu afterwards. Check `crafted`: whole recipes can give more than asked (4 sticks per craft), and missing materials give fewer. On failure, `step` and `missing` say what to fix.

| Item | Ingredients |
|---|---|
| iron pickaxe | 3 iron ingots + 2 sticks |
| diamond pickaxe | 3 diamonds + 2 sticks |
| bucket | 3 iron ingots |
| flint and steel | 1 iron ingot + 1 flint (flint drops sometimes when breaking gravel) |
| shield | 6 planks + 1 iron ingot |
| iron sword | 2 iron ingots + 1 stick |
| torch | 1 coal or charcoal + 1 stick → 4 |
| bed | 3 wool of one colour + 3 planks |
| blaze powder | 1 blaze rod → 2 |
| eye of ender | 1 ender pearl + 1 blaze powder |

For anything else, call `lookup_recipe({ recipe_or_output_id_glob: "minecraft:<item>" })` before gathering materials.

## Next

Equip a new pickaxe as soon as it is crafted. With an iron pickaxe, load `ore_mining` for diamonds; with a diamond pickaxe, load `nether_portal`.
