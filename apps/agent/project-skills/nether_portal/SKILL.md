---
schema_version: 1
name: nether_portal
description: Use when you need obsidian, a Nether portal, or to enter the Nether. Covers obsidian sources, water and lava buckets, the frame layout, lighting and entering.
---
# nether_portal

You need 10 obsidian, 4 cheap blocks for the corners, and flint and steel: 1 iron ingot plus 1 flint. Flint drops sometimes when you break gravel; break and collect gravel until one drops.

## Obsidian

Only a diamond pickaxe drops obsidian; any other tool destroys it. Each block takes about 9 seconds to mine.

1. Query `find_known_blocks({ block_id_glob: "minecraft:obsidian" })`. Obsidian forms where water reached lava, often in caves near lava pools. Ruined portals also contain obsidian; crying obsidian does not count.
2. Otherwise make it from a lava pool. A lava source (level=0) touched by water from the side or from above turns into obsidian; flowing lava turns into cobblestone. Water poured onto the top of a block at the pool's edge, level with the lava, spreads over the surface and turns every source it covers into obsidian, so one pour can give many blocks. Pouring straight into one lava cell only converts its neighbours.
3. Get water with `fill_bucket({ fluid: "water" })` (a bucket is 3 iron ingots). Only source cells (level=0) fill a bucket. Keep the water: after a pour, pick it back up from the cell it was placed in, which `effect_position` reports.
4. Deep caves below about Y -55 often hold large lava pools.

```ts
// Pour once from the edge of a known lava pool, then take the water back.
const lava = await abilities.find_known_blocks({ block_id_glob: "minecraft:lava" });
if (!lava.ok) return lava.message;
for (const source of lava.data.matches.filter((match) => match.block_state.includes("level=0"))) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const edge = { x: source.position.x + dx, y: source.position.y, z: source.position.z + dz };
    const above = { ...edge, y: edge.y + 1 };
    const [edgeSeen, aboveSeen] = [await abilities.observe_block(edge), await abilities.observe_block(above)];
    const edgeCell = edgeSeen.ok ? edgeSeen.data.cells[0] : undefined;
    const aboveCell = aboveSeen.ok ? aboveSeen.data.cells[0] : undefined;
    if (edgeCell?.state !== "KNOWN_BLOCK" || edgeCell.fluid !== "minecraft:empty" || aboveCell?.state !== "KNOWN_AIR") continue;
    const poured = await abilities.goto_and_use_item_on_block({ item_id: "minecraft:water_bucket", position: edge });
    if (!poured.ok) { console.log(JSON.stringify(edge), poured.message); continue; }
    await abilities.wait({ seconds: 2 });
    const water = poured.data.outcome === "adjacent_block_changed" ? poured.data.effect_position : above;
    const back = await abilities.goto_and_use_item_on_block({ item_id: "minecraft:bucket", position: water });
    await abilities.look_around({});
    const obsidian = await abilities.find_known_blocks({ block_id_glob: "minecraft:obsidian" });
    return { poured_at: edge, water_back: back.message, obsidian: obsidian.ok ? obsidian.data.matches.length : 0 };
  }
}
return "no known lava source has a dry edge block with air above it; observe the pool first";
```

Mining it: a drop that falls into lava burns. Before breaking an obsidian block, check the cell below; take the blocks with a solid floor first, then pour again so the lava exposed underneath also turns to obsidian. Fight and eat before working beside lava, and keep cobblestone ready to block a flow toward you.

## Frame

Pick flat solid ground with free space 4 wide and 5 tall. The frame stands on the ground, and the 2x3 space inside it must stay air. Corners can be any block, and the top row needs them as support. Place bottom-up.

A block can only be placed on a top face you can see, so faces above your eyes need a raised stance: before the third row, stand 3 blocks up in front of the frame; `goto` to that exact cell pillars up with scaffold blocks (carry some cobblestone).

```ts
const self = await abilities.observe_self({});
if (!self.ok) return self.message;
const base = { x: self.data.feet.x + 2, y: self.data.feet.y, z: self.data.feet.z };
const filler = "minecraft:cobblestone";
const side = "minecraft:obsidian";
const rows: ReadonlyArray<ReadonlyArray<readonly [number, string]>> = [
  [[0, filler], [1, side], [2, side], [3, filler]],
  [[0, side], [3, side]],
  [[0, side], [3, side]],
  [[0, side], [3, side]],
  [[0, filler], [3, filler], [1, side], [2, side]],
];
for (const [dy, row] of rows.entries()) {
  if (dy === 2) {
    const raised = await abilities.goto({ x: base.x + 1, y: base.y + 3, z: base.z - 1, exact: true });
    if (!raised.ok) return `could not stand above the frame: ${raised.message}`;
  }
  for (const [dx, item_id] of row) {
    const position = { x: base.x + dx, y: base.y + dy, z: base.z };
    const placed = await abilities.goto_and_place_block({ item_id, position });
    if (!placed.ok) return `stopped at ${JSON.stringify(position)}: ${placed.message}`;
  }
}
const lit = await abilities.goto_and_use_item_on_block({
  item_id: "minecraft:flint_and_steel", position: { x: base.x + 1, y: base.y, z: base.z },
});
const portal = await abilities.find_known_blocks({ block_id_glob: "minecraft:nether_portal" });
return { lit: lit.message, portal_blocks: portal.ok ? portal.data.matches.length : 0, base };
```

If a cell is occupied, break that one block and retry rather than moving the whole frame. The flint and steel must hit the top face of a bottom obsidian block from a spot where that face is visible. Success shows `minecraft:nether_portal` blocks; break the scaffold pillar afterwards if it blocks the way in.

## Enter

Walk into an inner cell, for example `goto({ x: base.x + 1, y: base.y + 1, z: base.z, exact: true })`, then `wait({ seconds: 5 })`. Standing in the portal for 4 seconds teleports you. Confirm with `observe_self` that `dimension` is `minecraft:the_nether`, and note the arrival position: a linked portal stands there for the way back.

In the Nether: lava lakes and cliffs are everywhere, water cannot be placed, and beds explode. Ghasts shoot from a distance. Zombified piglins fight back as a group if you hit one. Piglins are hostile unless you wear a piece of gold armour.

## Next

Load `blaze_fortress` when you need blaze rods.
