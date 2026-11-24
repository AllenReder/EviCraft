package dev.mcagent.runtime.core.tools.interact;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.core.task.interact.PlaceBlockTaskRecord;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import net.minecraft.world.item.BlockItem;

import java.util.Map;
import java.util.function.Consumer;

import static dev.mcagent.runtime.task.TaskDispatch.ctx;
import static dev.mcagent.runtime.task.TaskDispatch.runSync;

/** Exact one-cell placement into one known-air target. */
public final class PlaceBlockTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }

    private static final long TIMEOUT_TICKS = 30L * 20L;

    @Override
    public String name() {
        return PlaceBlockTaskRecord.TOOL_NAME;
    }

    @Override
    public String description() {
        return "Place one carried block item at a known-air position, without travelling. A bed is "
                + "addressed by its foot and a door by its lower half; every cell the block will occupy "
                + "must be known air; other multi-cell blocks are not supported. The Runtime picks a "
                + "known support to place against, places once, and verifies the placed blocks and the "
                + "consumed item.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .string("item_id", "Exact canonical carried BlockItem id.")
                .object("position", "Exact current-dimension known-air anchor: bed foot or door lower half.", position ->
                        position.integer("x", "Block X")
                                .integer("y", "Block Y")
                                .integer("z", "Block Z"))
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer bot,
                             Consumer<String> reply) {
        ExactInteractionToolArgs.ItemAtPosition parsed =
                ExactInteractionToolArgs.itemAtPosition(args);
        BlockItem blockItem = parsed.item() instanceof BlockItem value ? value : null;
        runSync(bot, new PlaceBlockTaskRecord(toolCallId,
                ctx(toolCallId, bot).deadline(TIMEOUT_TICKS), parsed.itemId(), parsed.item(),
                blockItem, parsed.position()), reply);
    }
}
