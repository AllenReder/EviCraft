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

/** World-action tool (raw RuntimeTool): equip an item (tool/weapon/armor/accessory) from the inventory. */
public final class EquipItemTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }


    private static final Gson GSON = new Gson();
    private final InventoryOps impl = new InventoryOps();

    private record Args(String action, String item_id, String slot) {}

    @Override
    public String name() {
        return "equip_item";
    }

    @Override
    public String description() {
        return "Equip a carried item or take equipment off. equip moves item_id to the slot that "
                + "suits it (the main hand for tools and weapons, the matching slot for armour) or to "
                + "the given slot; the item it replaces returns to the inventory. unequip empties the "
                + "given slot into the inventory (armor means all four pieces) and fails when there is "
                + "no room.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .optionalEnum("action", "equip (default): wear/wield item_id. "
                        + "unequip: empty a slot back into the inventory.",
                        "equip", "unequip")
                .optionalString("item_id", "Namespaced id of the item to equip; must be in the "
                        + "inventory. Required to equip, ignored for unequip.")
                .optionalEnum("slot", "equip: omit to auto-route by item type, set only to force a "
                        + "hand or a specific armor piece. unequip: required — the slot to empty; "
                        + "'armor' means all four armor pieces.",
                        "mainhand", "offhand", "head", "chest", "legs", "feet", "armor")
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer bot, Consumer<String> reply) {
        Args a = GSON.fromJson(args, Args.class);
        runSync(bot, impl.equipItem(a.action(), a.item_id(), a.slot(), ctx(toolCallId, bot)), reply);
    }
}
