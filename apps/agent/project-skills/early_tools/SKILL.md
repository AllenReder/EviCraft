---
schema_version: 1
name: early_tools
description: Use when you have no pickaxe, only a wooden one, or lost your tools after death. Covers logs, planks, sticks, crafting table, wooden and stone tools, furnace.
---
# early_tools

Order: logs → planks and sticks → crafting table → wooden pickaxe → cobblestone → stone pickaxe and a spare → furnace. Skip whatever you already carry, and gather each material once in a sufficient amount instead of in many small trips.

## Costs (Minecraft 1.21.1)

| Item | Recipe |
|---|---|
| planks | 1 log → 4 planks of the same wood (`oak_log` → `oak_planks`) |
| sticks | 2 planks → 4 sticks |
| crafting table | 4 planks |
| wooden pickaxe | 3 planks + 2 sticks |
| stone pickaxe | 3 cobblestone + 2 sticks |
| furnace | 8 cobblestone |

Collect 6–8 logs in one pass: that covers the table, sticks, a wooden pickaxe and spare planks for fuel. Then get about 20 cobblestone: two stone pickaxes, a furnace and a few spare blocks. Stone drops cobblestone only when mined with a pickaxe.

## Tools

- A wooden pickaxe mines stone and coal ore. A stone pickaxe also mines iron, copper and lapis ore. Iron is needed for diamond, gold and redstone ore, and diamond for obsidian. Breaking an ore with a lower tier gives no drop.
- Uses before breaking: wooden 59, stone 131, iron 250, diamond 1561. Carry a spare pickaxe before long digging, and craft a replacement as soon as the last one breaks.
- Carry the pickaxe; breaking a block picks the best carried tool for it, so it does not have to be in your main hand.

## Workflow

`craft` deals with the crafting table for you: it uses the 2x2 grid when the recipe fits, otherwise a remembered table within 32 blocks, otherwise it places one (crafting it from planks if needed). Call it with the output item and how many new items you want, then read `crafted`.

```ts
const logs = await abilities.collect_blocks({ block_id_glob: "minecraft:*_log", count: 6 });
console.log(logs.message);
const inventory = await abilities.observe_inventory({});
const log = inventory.ok ? inventory.data.items.find((item) => item.item_id.endsWith("_log")) : undefined;
if (log === undefined) return "no logs carried";
const planks = log.item_id.replace(/_log$/u, "_planks");
const plan: ReadonlyArray<readonly [string, number]> = [
  [planks, 12], ["minecraft:stick", 4], ["minecraft:wooden_pickaxe", 1],
];
for (const [item_id, count] of plan) {
  const made = await abilities.craft({ item_id, count });
  console.log(item_id, made.ok ? `crafted ${made.data.crafted}, carrying ${made.data.carrying}` : made.message);
  if (!made.ok) break;
}
const held = await abilities.equip_item({ item_id: "minecraft:wooden_pickaxe" });
console.log(held.message);
```

For cobblestone, query `find_known_blocks({ block_id_glob: "minecraft:stone" })` and use `collect_blocks` with the same glob. If no stone is known, a short `mine_down({ depth: 4, direction: "north" })` exposes stone right under you. Then craft `minecraft:stone_pickaxe` (count 2) and `minecraft:furnace`, and equip a stone pickaxe.

Keep about 32 cheap blocks (cobblestone or dirt) for scaffolding; `goto` uses them to climb and bridge. More than that only fills the inventory.

## Next

With a stone pickaxe equipped, load `ore_mining` to find iron and coal. Load `smelt_craft` when you have raw iron to smelt.
