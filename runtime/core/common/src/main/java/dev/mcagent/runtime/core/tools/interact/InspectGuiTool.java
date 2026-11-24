package dev.mcagent.runtime.core.tools.interact;
import dev.mcagent.runtime.core.tools.GuiOps;

import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.function.Consumer;

/** Query tool (raw RuntimeTool): look at the currently open GUI / inventory menu. */
public final class InspectGuiTool implements RuntimeTool {

    private final GuiOps impl = new GuiOps();

    @Override
    public String name() {
        return "inspect_gui";
    }

    @Override
    public String description() {
        return "Read the open menu: the block menu if one is open, otherwise the own inventory menu "
                + "of the Bot with its 2x2 crafting grid. Returns menu_type (the registry id, null for "
                + "the own inventory), menu_id and menu_revision (required by transfer and "
                + "menu_button), every slot with its index, role, item and count, the cursor stack, and "
                + "data_values: the synced integers of the menu, such as furnace burn and cook "
                + "progress.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.none();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer self, Consumer<String> reply) {
        reply.accept(impl.inspectGui(self));
    }
}
