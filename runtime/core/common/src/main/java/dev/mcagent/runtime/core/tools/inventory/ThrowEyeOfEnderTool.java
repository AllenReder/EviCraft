package dev.mcagent.runtime.core.tools.inventory;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.core.tools.InventoryOps;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.function.Consumer;

import static dev.mcagent.runtime.task.TaskDispatch.ctx;
import static dev.mcagent.runtime.task.TaskDispatch.setTask;

/** Public no-argument seam for one native, embodied Ender Eye observation. */
public final class ThrowEyeOfEnderTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }


    private final InventoryOps impl = new InventoryOps();

    @Override
    public String name() {
        return "throw_eye_of_ender";
    }

    @Override
    public String description() {
        return "Throw one carried Ender Eye. Returns the horizontal direction it flew after five "
                + "ticks, and whether it dropped (with the UUID of the dropped item entity) or "
                + "shattered. Refused while a block menu is open.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.none();
    }

    @Override
    public void onServerCall(
            String toolCallId, JsonObject args, BotPlayer bot, Consumer<String> reply) {
        setTask(bot, impl.throwEyeOfEnder(ctx(toolCallId, bot)), args, reply);
    }
}
