import { defineMinecraftTask } from "../minecraft-common/task.ts";

export const discoveryAssignment = "Starting with an empty inventory, obtain as many different item types as you can. An item type counts once, the first time you hold it in your inventory, a hand, or an armor slot. It still counts after you use it up, drop it, store it, or lose it on death, so you do not need to keep items, fill your inventory, or collect many of one type. Item types are distinguished by item ID: for example, oak planks and birch planks are different types. The run lasts a fixed amount of game time and ends automatically; you cannot end it early, so keep finding new item types until it stops. If you die, you respawn and continue. Choose your own objectives and use legitimate in-game methods.";

export default defineMinecraftTask({ id: "minecraft-item-discovery", revision: "2", assignment: discoveryAssignment, promptRevision: "3" });
