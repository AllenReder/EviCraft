---
schema_version: 1
name: survival_combat
description: Use when health or food is low, hostile mobs are close, night falls, or you just respawned after dying. Covers eating, hunting, fighting, retreating, sleeping and recovery.
---
# survival_combat

## Food

- Health only regenerates while food is 18 or more out of 20. Eat once food drops to about 14, before a long dig or a fight.
- Eating at full food only wastes time; call `eat({ item_id })` when food is below 20.
- Good food: cooked beef or porkchop (8), cooked mutton or chicken (6), bread (5, from 3 wheat). Raw meat is weaker and raw chicken can poison you; cook meat in a furnace (`smelt_craft`).
- Cows, pigs, sheep and chickens drop meat. Kill a few with `attack({ uuids: [uuid] })`, then `collect_items({ item_id_glob: "minecraft:*", radius: 8 })`.

## Fighting

1. `observe_entities({ entity_id_glob })` and choose VISIBLE `uuid`s. `attack({ uuids })` chooses the weapon and timing itself and fights until it finishes or is interrupted. Leaving `uuids` out attacks every hostile visible at the start.
2. Read `defeated_uuids`; `lost_uuids` and `unreachable_uuids` were not killed. Drops are not collected automatically; `observed_drop_entities` lists them for `collect_items`.
3. Hold a sword or axe (iron sword: 2 iron ingots + 1 stick). Fight on flat ground away from lava and drops.

| Mob | Note |
|---|---|
| zombie, skeleton, spider | common at night and underground in the dark; skeletons shoot from range |
| creeper | explodes next to you; kill it fast or move away |
| enderman | neutral until hit or looked at; strong, teleports |
| zombified piglin | the whole group attacks if you hit one |
| drowned, witch | ranged or water threats; usually avoid |

## Low health

When health is low, or a hazard interrupts you, first get safe, then recover:

1. Move away from the threat with `goto` toward a known safe spot, such as the way you came.
2. Wall yourself in if mobs keep coming: `place_block_nearby({ item_id: "minecraft:cobblestone" })` a few times, or dig one block into a wall.
3. Eat, and wait for health to come back before going on.

Stay out of lava (`in_lava`, `on_fire` in `observe_self`); water puts out fire.

## Night and sleep

Hostile mobs spawn in darkness: on the surface at night and anywhere unlit underground. A bed (3 wool of one colour + 3 planks) skips the night and sets your respawn point. Place it, then call `sleep_in_bed({ distance: 16 })`. Beds explode in the Nether and the End.

## After death

You respawn at your bed or the world spawn with an empty inventory. Your items lie where you died and disappear after 5 minutes. Go back for them only when that spot is close and safe. Otherwise rebuild: load `early_tools`. Knowledge of crafting tables and furnaces you placed is still valid if you can reach them.
