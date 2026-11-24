package dev.mcagent.runtime.core.tools.work;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.core.tools.CombatOps;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import static dev.mcagent.runtime.task.TaskDispatch.ctx;
import static dev.mcagent.runtime.task.TaskDispatch.setTask;

/**
 * Defeats the given entities. <b>The model is not asked which weapon to use</b>: that depends on the
 * distance on arrival, line of sight, and arrows left, none of which the model can see at dispatch time.
 */
public final class AttackTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }


    private static final Gson GSON = new Gson();
    private final CombatOps impl = new CombatOps();

    private record Args(List<String> uuids) {}

    @Override
    public String name() {
        return "attack";
    }

    @Override
    public String description() {
        return "Fight tracked entities. With uuids it fights those 1-20 entities. With null it "
                + "fights the hostile entities that are visible until none is coming at the Bot, which "
                + "also covers mobs that split into new entities. The Runtime chooses between melee and "
                + "a carried bow or crossbow, picks the weapon for each target, and keeps away from "
                + "mobs about to explode. Drops are reported in observed_drop_entities and are not "
                + "collected.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .nullableStringArray("uuids",
                        "1-20 exact VISIBLE or unexpired KNOWN Entity Track UUIDs; null selects only currently VISIBLE hostile evidence.",
                        1, 20)
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer bot,
                             Consumer<String> reply) {
        Args a = GSON.fromJson(args, Args.class);
        setTask(bot, impl.attack(a.uuids(), ctx(toolCallId, bot)), args, reply);
    }
}
