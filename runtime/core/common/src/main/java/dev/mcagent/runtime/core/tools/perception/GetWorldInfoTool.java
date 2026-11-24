package dev.mcagent.runtime.core.tools.perception;
import dev.mcagent.runtime.core.tools.PerceptionOps;

import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.function.Consumer;

/** Query tool (raw RuntimeTool): read the current world state. */
public final class GetWorldInfoTool implements RuntimeTool {

    private final PerceptionOps impl = new PerceptionOps();

    @Override
    public String name() {
        return "get_world_info";
    }

    @Override
    public String description() {
        return "Report whether it is day or night and the difficulty. Exact game time, the seed "
                + "and structure locations are not reported.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.none();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer self, Consumer<String> reply) {
        reply.accept(impl.getWorldInfo(self));
    }
}
