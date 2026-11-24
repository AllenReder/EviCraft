package dev.mcagent.runtime.core.tools.interact;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.core.tools.SleepOps;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;

import java.util.Map;
import java.util.function.Consumer;

/** Safe exact bed entry with evidence binding and verified sleeping. */
public final class EnterBedTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }

    private final SleepOps sleep = new SleepOps();

    @Override
    public String name() {
        return "enter_bed";
    }

    @Override
    public String description() {
        return "Get into one known bed, without travelling. Either half may be given. Refused in "
                + "dimensions where beds explode. Succeeds once the Bot is sleeping; this sets the "
                + "respawn point, and the call returns without waiting for morning.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .object("position", "Exact current-dimension known bed position.", position ->
                        position.integer("x", "Block X")
                                .integer("y", "Block Y")
                                .integer("z", "Block Z"))
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer self,
                             Consumer<String> reply) {
        BlockPos position = ExactInteractionToolArgs.positionOnly(args);
        reply.accept(sleep.enterBed(position, self));
    }
}
