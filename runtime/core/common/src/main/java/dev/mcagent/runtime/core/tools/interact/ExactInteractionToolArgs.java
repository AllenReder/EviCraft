package dev.mcagent.runtime.core.tools.interact;

import dev.mcagent.runtime.agent.tool.ToolArgs;
import dev.mcagent.runtime.core.tools.ToolParse;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.world.item.Item;

/** Strict shared parser for exact block-interaction Tool arguments. */
final class ExactInteractionToolArgs {
    private ExactInteractionToolArgs() {}

    static BlockPos positionOnly(JsonObject args) {
        if (args == null || args.size() != 1 || !args.has("position")
                || !args.get("position").isJsonObject()) {
            throw new IllegalArgumentException("exact position object is required");
        }
        return ToolParse.position(args.getAsJsonObject("position"));
    }

    static ItemAtPosition itemAtPosition(JsonObject args) {
        if (args == null || args.size() != 2 || !args.has("item_id")
                || !args.get("item_id").isJsonPrimitive()
                || !args.getAsJsonPrimitive("item_id").isString()
                || !args.has("position") || !args.get("position").isJsonObject()) {
            throw new IllegalArgumentException("exact item_id and position are required");
        }
        String itemId = args.get("item_id").getAsString();
        return new ItemAtPosition(itemId, ToolArgs.parseItem(itemId),
                ToolParse.position(args.getAsJsonObject("position")));
    }

    record ItemAtPosition(String itemId, Item item, BlockPos position) {}
}
