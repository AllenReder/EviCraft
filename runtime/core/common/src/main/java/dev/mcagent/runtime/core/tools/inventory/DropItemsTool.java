package dev.mcagent.runtime.core.tools.inventory;
import dev.mcagent.runtime.core.tools.InventoryOps;

import static dev.mcagent.runtime.task.TaskDispatch.*;

import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.function.Consumer;

/** World-action tool (raw RuntimeTool): drop items onto the ground in front of the body. */
public final class DropItemsTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }


    private static final Gson GSON = new Gson();
    private final InventoryOps impl = new InventoryOps();

    private record Args(String item_id, int count) {}

    @Override
    public String name() {
        return "drop_items";
    }

    @Override
    public String description() {
        return "Drop up to count of one carried item in front of the Bot. A count above the carried "
                + "amount drops all of it. Returns how many were dropped and how many remain.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .string("item_id", "Namespaced id of the item to drop, e.g. minecraft:cobblestone.")
                .integer("count", "How many to drop (1-999).", 1, 999)
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer bot, Consumer<String> reply) {
        Args a = GSON.fromJson(args, Args.class);
        runSync(bot, impl.dropItems(a.item_id(), a.count(), ctx(toolCallId, bot)), reply);
    }
}
