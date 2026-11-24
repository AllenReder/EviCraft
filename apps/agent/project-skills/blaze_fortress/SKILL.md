---
schema_version: 1
name: blaze_fortress
description: Use when you are in the Nether and need blaze rods or blaze powder. Covers finding a fortress, fighting blazes, collecting rods and crafting powder.
---
# blaze_fortress

## Find a fortress

Nether fortresses are dark nether-brick bridges and corridors (`minecraft:nether_bricks`, `minecraft:nether_brick_fence`, `minecraft:nether_brick_stairs`). They are large and often span open lava areas.

1. Query `find_known_blocks({ block_id_glob: "minecraft:nether_brick*" })`.
2. Nothing known: run `explore_and_return({ max_outbound_displacement: 96 })` and query again. Bridges are long, so once any nether brick is known, follow it.
3. Record the portal position before leaving it. Coming back means walking to it with `goto`.

## Blazes

Blazes spawn around blaze spawners in the fortress, at any light level. They fly, shoot fireballs and are immune to fire and lava.

1. `observe_entities({ entity_id_glob: "minecraft:blaze" })`, then pick one VISIBLE `uuid`.
2. `attack({ uuids: [uuid] })`. A kill shows up in `defeated_uuids`; `lost_uuids` is not a kill.
3. `collect_items({ item_id_glob: "minecraft:blaze_rod", radius: 12 })`. A blaze drops 0–1 rod, so expect a few kills per rod.
4. Recheck health between fights; eat or step back from fireballs before engaging again. Fight on solid floor away from edges and lava.

One rod crafts into 2 blaze powder (`craft({ item_id: "minecraft:blaze_powder", count: 2 })`). Twelve eyes of ender need 12 powder (6 rods) and 12 ender pearls.

Wither skeletons (dark, with stone swords) also roam fortresses and cause Wither; fight them only when needed.

## Next

Load `end_portal` for pearls, eyes and the stronghold.
