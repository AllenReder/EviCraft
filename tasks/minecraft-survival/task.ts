import { defineMinecraftTask } from "../minecraft-common/task.ts";

export const survivalAssignment = "Starting with an empty inventory, advance as far as you can through Minecraft's survival progression. The key milestones, in order, are: obtain iron ingots, activate a Nether portal, and activate an End portal. Progress is judged by the furthest milestone you have ever reached; it is not lost when items are later used up, dropped, or lost on death. The run lasts a fixed amount of game time and ends automatically; you cannot end it early, so keep working toward the next milestone until it stops. If you die, you respawn and continue. Plan your own exploration and actions, and use legitimate in-game methods.";

export default defineMinecraftTask({ id: "minecraft-survival", revision: "2", assignment: survivalAssignment, promptRevision: "3" });
