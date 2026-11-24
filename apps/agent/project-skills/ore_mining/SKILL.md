---
schema_version: 1
name: ore_mining
description: Use when you need coal, iron, diamonds or another ore and none is known nearby, or a tunnel or descent found nothing. Covers ore heights, ID globs, caves, branch mining and getting back up.
---
# ore_mining

## 1. Use the right glob, and query before digging

Below Y 0–8 stone turns into deepslate, and ores there are `deepslate_*_ore`. A glob must cover both forms: `minecraft:*iron_ore` matches `iron_ore` and `deepslate_iron_ore`. `minecraft:*_iron_ore` misses `iron_ore`, and `minecraft:iron_ore` misses `deepslate_iron_ore`.

| Ore | Glob | Pickaxe | Where it generates (Minecraft 1.21.1, Y levels) | Drop |
|---|---|---|---|---|
| coal | `minecraft:*coal_ore` | wooden | 0 to 320, most around 96; common on exposed hills | coal |
| iron | `minecraft:*iron_ore` | stone | -24 to 56, most around 16; also abundant high in mountains (80+, peak ~232); a thin spread from -64 to 72 | raw_iron |
| copper | `minecraft:*copper_ore` | stone | -16 to 112, most around 48 | raw_copper |
| lapis | `minecraft:*lapis_ore` | stone | -64 to 64, most around 0 | lapis_lazuli |
| gold | `minecraft:*gold_ore` | iron | -64 to 32, most around -16 | raw_gold |
| redstone | `minecraft:*redstone_ore` | iron | -64 to 15, more the deeper | redstone |
| diamond | `minecraft:*diamond_ore` | iron | -64 to 16, more the deeper; best around -53 to -58 | diamond |

Large iron veins mixed with tuff also run between Y -60 and -8. Bedrock fills Y -64 to -60.

Always call `find_known_blocks` with the glob first. If it returns matches, equip a suitable pickaxe and call `collect_blocks({ block_id_glob, count })`. Ores come in clusters, so ask for several (count 4–8). Read `collected_items` to see what you actually got.

## 2. Look where ores are exposed

- Caves and ravines expose a lot of wall, and most ores show up on it. When `mine_down` or `tunnel_for_blocks` stops with `open_space_below`, you have reached a cave: query `find_known_blocks` again before digging further.
- On the surface, cliffs and mountain sides show coal and iron; `explore_and_return({ max_outbound_displacement: 48 })` reveals more terrain cheaply.
- Diamonds rarely touch air. Caves expose few of them, so branch mining is the reliable way to find diamonds.

## 3. Branch mine at the target height

1. Record your feet before descending. `mine_down({ depth, direction })` with a cardinal direction digs a staircase you can walk back up (at most 64 levels per call). Pick the depth from the table: about Y 16 for iron, about Y -54 for diamonds.
2. At the target height, run straight 1x2 tunnels with `tunnel_for_blocks`. Each tunnel shows the ores in its walls. Keep parallel tunnels 3 blocks apart, so the two blocks of wall between them have both been seen.
3. Read every stop. `hazard` means lava ahead: turn to another direction. `open_space_below` means a cave: query and look there. `blocked` means change direction. Never dig straight down under your feet next to lava.
4. Mining uses up the pickaxe. Check that it is still carried every few tunnels, and keep a spare.

```ts
const glob = "minecraft:*iron_ore";
const opposite = { north: "south", south: "north", east: "west", west: "east" } as const;
let direction: "north" | "south" | "east" | "west" = "north";
let report = "no match in 4 tunnels";
for (let leg = 0; leg < 4; leg++) {
  const tunnel = await abilities.tunnel_for_blocks({ block_id_glob: glob, direction, max_length: 24 });
  if (!tunnel.ok) { report = `stopped: ${tunnel.message}`; break; }
  if (tunnel.data.found) {
    const ore = await abilities.collect_blocks({ block_id_glob: glob, count: 6 });
    report = `${ore.message} ${JSON.stringify(ore.data.collected_items)}`;
    break;
  }
  const shift = await abilities.tunnel_for_blocks({ block_id_glob: glob, direction: "east", max_length: 3 });
  if (!shift.ok) { report = `shift stopped: ${shift.message}`; break; }
  direction = opposite[direction];
}
const self = await abilities.observe_self({});
return { report, feet: self.ok ? self.data.feet : null };
```

## 4. How much to take, and getting back

- Iron: 3 ingots for an iron pickaxe, 3 for a bucket, 1 for flint and steel. About 8–10 raw iron covers the next steps.
- Diamonds: 3 for a diamond pickaxe (2 more for a sword if you want one).
- Coal: one coal smelts 8 items. Grab what you pass; planks and logs also burn.
- To return, `goto` the recorded staircase start. `goto` can dig and place scaffold blocks, so carry some cobblestone. `surface` only works in water.

Load `smelt_craft` to turn raw ore into tools. With a diamond pickaxe, load `nether_portal` for obsidian.
