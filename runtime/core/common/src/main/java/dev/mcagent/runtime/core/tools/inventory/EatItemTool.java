package dev.mcagent.runtime.core.tools.inventory;
import dev.mcagent.runtime.core.tools.InventoryOps;

import static dev.mcagent.runtime.task.TaskDispatch.*;

import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.ToolArgs;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.List;
import java.util.function.Consumer;

/**
 * Eats or drinks an item from the inventory. <b>Asynchronous</b>: one bite takes 32 ticks and eating until
 * full can take much longer, too long to hold a conversation turn; emits task_finished when done.
 */
public final class EatItemTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }


    private final InventoryOps impl = new InventoryOps();

    @Override
    public String name() {
        return "eat";
    }

    @Override
    public String description() {
        return "Eat or drink one carried food, milk bucket or drinkable potion. Give either item_id "
                + "or an Inventory slot from get_self_status; a slot is needed when carried stacks of "
                + "that item differ, such as potion variants. Returns the consumed count, any returned "
                + "container and the resulting state. Splash and lingering potions are refused; "
                + "ordinary food is refused at full hunger.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        Map<String, Object> schema = Schema.object()
                .optionalString("item_id", "Exact canonical food/drink id; different variants require slot instead.")
                .optionalInteger("slot", "Exact current Inventory slot, not a Menu index.", 0, 40)
                .build();
        schema.put("oneOf", List.of(Map.of("required", List.of("item_id")), Map.of("required", List.of("slot"))));
        return schema;
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer bot, Consumer<String> reply) {
        if (args.has("item_id") == args.has("slot")) {
            throw new IllegalArgumentException("provide exactly one of item_id or slot");
        }
        String itemId = args.has("item_id") ? args.get("item_id").getAsString() : null;
        Integer slot = args.has("slot") ? ToolArgs.requireInt(args, "slot") : null;
        if (slot != null && (!args.getAsJsonPrimitive("slot").isNumber()
                || args.get("slot").getAsDouble() != slot)) {
            throw new IllegalArgumentException("slot must be an integer Inventory index");
        }
        setTask(bot, impl.eatItem(itemId, slot, ctx(toolCallId, bot)), args, reply);
    }
}
