package dev.mcagent.runtime.core.tools.interact;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.core.task.interact.GotoBlockPlacementPoseTaskRecord;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import net.minecraft.world.item.BlockItem;

import java.util.Map;
import java.util.function.Consumer;

import static dev.mcagent.runtime.task.TaskDispatch.ctx;
import static dev.mcagent.runtime.task.TaskDispatch.runSync;

/** Navigate to one verified, item-specific native placement context without placing anything. */
public final class GotoBlockPlacementPoseTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }

    private static final long TIMEOUT_TICKS = 30L * 20L;

    @Override
    public String name() {
        return GotoBlockPlacementPoseTaskRecord.TOOL_NAME;
    }

    @Override
    public String description() {
        return "Walk to a standable cell from which a carried single-cell block item can be placed "
                + "at the target cell. The target may be unknown. The route protects the target and its "
                + "known supports. Nothing is placed.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .string("item_id", "Exact canonical carried BlockItem id.")
                .object("position", "Exact current-dimension placement target; unknown cells may be approached.", position ->
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
        runSync(bot, new GotoBlockPlacementPoseTaskRecord(toolCallId,
                ctx(toolCallId, bot).deadline(TIMEOUT_TICKS), parsed.itemId(), parsed.item(),
                blockItem, parsed.position()), reply);
    }
}
