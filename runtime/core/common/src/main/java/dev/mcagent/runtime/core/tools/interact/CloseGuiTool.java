package dev.mcagent.runtime.core.tools.interact;
import dev.mcagent.runtime.core.tools.GuiOps;

import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.function.Consumer;

/** Query tool (raw RuntimeTool): close the open container GUI. */
public final class CloseGuiTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }


    private final GuiOps impl = new GuiOps();

    @Override
    public String name() {
        return "close_gui";
    }

    @Override
    public String description() {
        return "Close the open block menu. Also succeeds when none is open.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.none();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer self, Consumer<String> reply) {
        reply.accept(impl.closeGui(self));
    }
}
