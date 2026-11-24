package dev.mcagent.runtime.core.tools.interact;

import static dev.mcagent.runtime.task.TaskDispatch.*;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.core.task.interact.BreakBlockTaskRecord;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.function.Consumer;

/** Breaks one exact known block from the current position. */
public final class BreakBlockTool implements RuntimeTool {
    private static final long TIMEOUT_TICKS = 30L * 20L;

    @Override
    public Execution execution() {
        return Execution.BODY;
    }

    @Override
    public String name() {
        return BreakBlockTaskRecord.TOOL_NAME;
    }

    @Override
    public String description() {
        return "Break one known block from the current position, without travelling. Outside "
                + "creative mode the Runtime holds the best carried tool for that block: one that "
                + "harvests it, then the fastest; with none it breaks by hand. Succeeds when the "
                + "block is gone and reports the item drops it observed. Fails if the block is not "
                + "known, out of reach (about 4.5 blocks), or another block or entity is hit first.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .object("position", "Position of the known block, in the current dimension.", position ->
                        position.integer("x", "Block X")
                                .integer("y", "Block Y")
                                .integer("z", "Block Z"))
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer bot,
                             Consumer<String> reply) {
        runSync(bot, new BreakBlockTaskRecord(toolCallId,
                ctx(toolCallId, bot).deadline(TIMEOUT_TICKS),
                ExactInteractionToolArgs.positionOnly(args)), reply);
    }
}
