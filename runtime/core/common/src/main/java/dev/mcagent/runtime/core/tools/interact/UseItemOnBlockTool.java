package dev.mcagent.runtime.core.tools.interact;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.core.task.interact.UseItemOnBlockTaskRecord;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.function.Consumer;

import static dev.mcagent.runtime.task.TaskDispatch.ctx;
import static dev.mcagent.runtime.task.TaskDispatch.runSync;

/** Verified use of one exact carried non-BlockItem on one exact known block. */
public final class UseItemOnBlockTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }

    private static final long TIMEOUT_TICKS = 30L * 20L;

    @Override
    public String name() {
        return UseItemOnBlockTaskRecord.TOOL_NAME;
    }

    @Override
    public String description() {
        return "Use one carried item, other than a block item, on one known block, without "
                + "travelling: one main-hand use on a face the Runtime chooses. Succeeds when the item "
                + "or the nearby block states change as that item should change them. An empty bucket "
                + "needs a known fluid source; in the Nether a water bucket empties without placing "
                + "water.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .string("item_id", "Exact canonical carried item id.")
                .object("position", "Exact current-dimension known block position.", position ->
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
        runSync(bot, new UseItemOnBlockTaskRecord(toolCallId,
                ctx(toolCallId, bot).deadline(TIMEOUT_TICKS), parsed.itemId(), parsed.item(),
                parsed.position()), reply);
    }
}
