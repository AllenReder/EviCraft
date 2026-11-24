package dev.mcagent.runtime.core.tools.interact;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.core.tools.GuiOps;
import dev.mcagent.runtime.core.tools.ToolParse;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.function.Consumer;

/** Presses one button of the open block menu. */
public final class MenuButtonTool implements RuntimeTool {
    private final GuiOps impl = new GuiOps();

    @Override
    public Execution execution() {
        return Execution.BODY;
    }

    @Override
    public String name() {
        return "menu_button";
    }

    @Override
    public String description() {
        return "Press one button of the open block menu, as a click on its screen would. The button "
                + "number is the menu's own: an enchanting table has options 0-2; a stonecutter or "
                + "loom takes the index of the recipe or pattern to select. Fails with no_effect "
                + "when the menu refuses the button. Menus without buttons, such as chests and "
                + "furnaces, need only transfer.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .integer("menu_id", "menu_id from inspect_gui.")
                .integer("menu_revision", "menu_revision from inspect_gui.")
                .integer("button", "The menu's button number.", 0, 255)
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer self, Consumer<String> reply) {
        reply.accept(impl.menuButton(ToolParse.integer(args, "menu_id"),
                ToolParse.integer(args, "menu_revision"), ToolParse.integer(args, "button"), self));
    }
}
