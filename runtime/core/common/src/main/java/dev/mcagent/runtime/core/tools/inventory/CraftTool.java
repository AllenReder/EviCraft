package dev.mcagent.runtime.core.tools.inventory;
import dev.mcagent.runtime.core.tools.CraftOps;

import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.function.Consumer;

/** World-action tool (raw RuntimeTool): craft an item start-to-finish in one call. */
public final class CraftTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }


    private static final Gson GSON = new Gson();
    private final CraftOps impl = new CraftOps();

    private record Args(String item_id, Integer count) {}

    @Override
    public String name() {
        return "craft";
    }

    @Override
    public String description() {
        return "Craft count of an item from carried materials: finds a crafting recipe, lays out the "
                + "grid and takes the result. 2x2 recipes work in the own inventory menu of the Bot; a "
                + "3x3 recipe needs a crafting-table menu that is already open (activate_block opens "
                + "it). Missing ingredients fail as missing_ingredients with the shortfalls. Stops "
                + "early, and says so, when materials run out or the inventory fills. Furnaces, "
                + "stonecutters and smithing tables are operated with transfer and menu_button.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .string("item_id", "Namespaced id of the item to craft, e.g. minecraft:iron_pickaxe.")
                .optionalInteger("count", "How many of the item you want (default 1).", 1, 256)
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer self, Consumer<String> reply) {
        Args a = GSON.fromJson(args, Args.class);
        reply.accept(impl.craft(a.item_id(), a.count(), self));
    }
}
