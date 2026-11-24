package dev.mcagent.runtime.core.tools.interact;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.core.task.interact.GotoBlockInteractionPoseTaskRecord;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;

import java.util.Map;
import java.util.function.Consumer;

import static dev.mcagent.runtime.task.TaskDispatch.ctx;
import static dev.mcagent.runtime.task.TaskDispatch.runSync;

/** Runtime-verified approach to one exact evidence-bound block. */
public final class GotoBlockInteractionPoseTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }

    private static final long TIMEOUT_TICKS = 30L * 20L;

    @Override
    public String name() {
        return GotoBlockInteractionPoseTaskRecord.TOOL_NAME;
    }

    @Override
    public String description() {
        return "Walk to a standable cell from which one known block can be reached and hit by the "
                + "native ray. The route never breaks or places at the target. With item_id, the pose "
                + "must let that carried item be used on the target, which is how a bucket reaches a "
                + "fluid cell.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .object("position", "Exact current-dimension known block position.", position ->
                        position.integer("x", "Block X")
                                .integer("y", "Block Y")
                                .integer("z", "Block Z"))
                .optionalString("item_id", "Carried item the pose must be able to use on the target.")
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer bot,
                             Consumer<String> reply) {
        long deadline = ctx(toolCallId, bot).deadline(TIMEOUT_TICKS);
        if (args != null && args.has("item_id")) {
            ExactInteractionToolArgs.ItemAtPosition parsed = ExactInteractionToolArgs.itemAtPosition(args);
            runSync(bot, new GotoBlockInteractionPoseTaskRecord(
                    toolCallId, deadline, parsed.position(), parsed.item()), reply);
            return;
        }
        BlockPos position = ExactInteractionToolArgs.positionOnly(args);
        runSync(bot, new GotoBlockInteractionPoseTaskRecord(
                toolCallId, deadline, position), reply);
    }
}
