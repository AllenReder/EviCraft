import type { AuthorityTeleport, TaskWorld } from "@evicraft/benchmark";

export async function initialize(world: TaskWorld, spawn: AuthorityTeleport): Promise<void> {
  await world.time.pause();
  await world.executeMinecraftCommand("time set 0");
  for (const command of ["difficulty easy", "gamemode survival @a", "gamerule keepInventory false", "gamerule doImmediateRespawn false", "gamerule doMobSpawning true", "gamerule doDaylightCycle true", "gamerule doWeatherCycle true"]) {
    // Vanilla setters can report failure when already at the requested value.
    await world.executeMinecraftCommand(command);
  }
  if ((await world.executeMinecraftCommand("difficulty")).result !== 1) throw new Error("The world must be at easy difficulty");
  await world.teleportActor(spawn);
  await world.setRespawnPoint({ dimension: spawn.dimension, x: Math.floor(spawn.x), y: Math.floor(spawn.y), z: Math.floor(spawn.z), yaw: spawn.yaw });
  for (let slot = 0; slot < 36; slot++) await world.setInventorySlot({ slot, itemId: "minecraft:air", count: 0 });
  for (const slot of ["offhand", "head", "chest", "legs", "feet"] as const) await world.setEquipment({ slot, itemId: "minecraft:air", count: 0 });
  await world.executeMinecraftCommand("effect clear @a");
}
