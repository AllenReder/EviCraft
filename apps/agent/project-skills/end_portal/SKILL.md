---
schema_version: 1
name: end_portal
description: Use when you need ender pearls, eyes of ender, a stronghold, or to activate the End portal. Covers Endermen, crafting eyes, following thrown eyes and filling the frames.
---
# end_portal

## Ender pearls

Endermen drop 0–1 pearl each. They appear on the Overworld at night (rarely in daytime) and are very common in the Nether's warped forest. They teleport when hit and are dangerous in groups.

1. `observe_entities({ entity_id_glob: "minecraft:enderman" })`, pick one VISIBLE `uuid`, `attack({ uuids: [uuid] })`.
2. `collect_items({ item_id_glob: "minecraft:ender_pearl", radius: 12 })`.
3. Repeat until you have enough. Fight with a sword in hand and enough health; Endermen avoid arrows.

An eye of ender is 1 ender pearl + 1 blaze powder; craft it with `craft`.

## Find the stronghold

1. In the Overworld, on open ground, call `throw_eye_of_ender({})`. `direction` points toward the nearest stronghold. The eye either drops (collect it with `collect_items` using `item_entity_uuid`) or shatters.
2. Travel 100–300 blocks along the horizontal part of `direction` (x and z) with `goto({ x, z })` steps, then throw again. Where two throws cross, the stronghold lies underground.
3. When an eye flies down into the ground close by, you are above it. Dig down with `mine_down` and look for stone bricks (`minecraft:*stone_bricks`) and the portal room (`minecraft:end_portal_frame`).

## Activate the portal

The portal has 12 `minecraft:end_portal_frame` blocks; `eye=true` in a frame's block state means it is already filled. Eyes needed = frames with `eye=false`.

```ts
const frames = await abilities.find_known_blocks({ block_id_glob: "minecraft:end_portal_frame" });
if (!frames.ok) return frames.message;
for (const frame of frames.data.matches.filter((match) => match.block_state.includes("eye=false"))) {
  const used = await abilities.goto_and_use_item_on_block({ item_id: "minecraft:ender_eye", position: frame.position });
  console.log(JSON.stringify(frame.position), used.message);
}
const portal = await abilities.find_known_blocks({ block_id_glob: "minecraft:end_portal" });
return portal.ok ? `end_portal blocks: ${portal.data.matches.length}` : portal.message;
```

When the last frame is filled, the inside turns into `minecraft:end_portal`. A silverfish spawner sits in the portal room; break it if silverfish keep coming.
