package dev.mcagent.runtime.core.tools.interact;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.core.task.interact.ActivateBlockTaskRecord;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;

import java.util.Map;
import java.util.function.Consumer;

import static dev.mcagent.runtime.task.TaskDispatch.ctx;
import static dev.mcagent.runtime.task.TaskDispatch.runSync;

/** Verified activation of one exact known block with a neutral main hand. */
public final class ActivateBlockTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }

    private static final long TIMEOUT_TICKS = 30L * 20L;

    @Override
    public String name() {
        return ActivateBlockTaskRecord.TOOL_NAME;
    }

    @Override
    public String description() {
        return "Right-click one known block with an empty main hand, without travelling. Succeeds "
                + "when a block menu opens or the state of that block changes.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .object("position", "Exact current-dimension known block position.", position ->
                        position.integer("x", "Block X")
                                .integer("y", "Block Y")
                                .integer("z", "Block Z"))
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer bot,
                             Consumer<String> reply) {
        BlockPos position = ExactInteractionToolArgs.positionOnly(args);
        runSync(bot, new ActivateBlockTaskRecord(toolCallId,
                ctx(toolCallId, bot).deadline(TIMEOUT_TICKS),
                position), reply);
    }
}
