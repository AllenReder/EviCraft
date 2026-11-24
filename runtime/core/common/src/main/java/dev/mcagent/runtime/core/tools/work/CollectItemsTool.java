package dev.mcagent.runtime.core.tools.work;
import dev.mcagent.runtime.core.tools.InventoryOps;

import static dev.mcagent.runtime.task.TaskDispatch.*;

import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/** World-action tool (raw RuntimeTool): pick up dropped items off the ground nearby. */
public final class CollectItemsTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }


    private static final Gson GSON = new Gson();
    private final InventoryOps impl = new InventoryOps();

    private record Args(
            List<String> uuids, String item_id_glob, Integer radius) {}

    @Override
    public String name() {
        return "collect_items";
    }

    @Override
    public String description() {
        return "Pick up tracked item drops. Give either 1-64 item-entity UUIDs or one item-id glob, "
                + "not both. Only drops whose known position is within radius (default 8, max 48) are "
                + "selected, and the Bot walks to each. A drop that has left what the Bot knows is "
                + "reported as target_lost, one that cannot be reached as unreachable. The world is "
                + "never scanned for drops the Bot does not know.";
    }


    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .nullableStringArray("uuids", "1-64 exact dropped-item Entity Track UUIDs, or null when using an item-id selector.", 1, 64)
                .optionalString("item_id_glob", "Bounded full-match Canonical ID Glob using * and ?; omit when using uuids.")
                .nullableInteger("radius", "Null = default 8; otherwise 1-48 blocks measured from Track positions.", 1, 48)
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer bot, Consumer<String> reply) {
        Args a = GSON.fromJson(args, Args.class);
        setTask(bot, impl.collectItems(
                a.uuids(), a.item_id_glob(), a.radius(),
                ctx(toolCallId, bot)), args, reply);
    }
}
