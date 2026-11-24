package dev.mcagent.runtime.core.tools.interact;
import dev.mcagent.runtime.core.tools.BlockActionOps;

import static dev.mcagent.runtime.task.TaskDispatch.*;

import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.function.Consumer;

/** Evidence-bound native right-click on one exact Entity Track UUID. */
public final class InteractEntityTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }


    private static final Gson GSON = new Gson();
    private final BlockActionOps impl = new BlockActionOps();

    private record Args(String uuid, Integer hold_ticks, String item_id) {}

    @Override
    public String name() {
        return "interact_entity";
    }

    @Override
    public String description() {
        return "Right-click one tracked entity by UUID. The Bot walks to the last known position of "
                + "the entity and interacts once that entity is visible and within reach. With item_id "
                + "the Bot holds that carried item first, such as wheat, shears or a bucket. Attacks go "
                + "through attack.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .string("uuid", "Exact UUID from an embodied Entity Track.")
                .nullableInteger("hold_ticks", "0/null = one right-click; >0 = bounded hold; -1 = hold until completion or task timeout.")
                .nullableString("item_id", "Optional namespaced item to equip-and-use, e.g. minecraft:wheat. Null = use what's in hand.")
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer bot, Consumer<String> reply) {
        Args a = GSON.fromJson(args, Args.class);
        runSync(bot, impl.interactEntity(a.uuid(), a.hold_ticks(), a.item_id(),
                ctx(toolCallId, bot)), reply);
    }
}
