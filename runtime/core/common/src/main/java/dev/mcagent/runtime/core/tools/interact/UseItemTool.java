package dev.mcagent.runtime.core.tools.interact;

import static dev.mcagent.runtime.task.TaskDispatch.*;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.ToolArgs;
import dev.mcagent.runtime.core.task.interact.UseItemTaskRecord;
import dev.mcagent.runtime.core.tools.ToolParse;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.world.item.Item;

import java.util.Map;
import java.util.function.Consumer;

/** Uses a carried item in open air: the right mouse button with nothing targeted. */
public final class UseItemTool implements RuntimeTool {
    private static final long TIMEOUT_TICKS = 30L * 20L;

    @Override
    public Execution execution() {
        return Execution.BODY;
    }

    @Override
    public String name() {
        return UseItemTaskRecord.TOOL_NAME;
    }

    @Override
    public String description() {
        return "Use a carried item in open air, without travelling: draw and release a bow, raise "
                + "a shield, throw a snowball or splash potion, cast or reel in a fishing rod. The "
                + "Bot faces aim, which must be a known air cell with nothing between it and the "
                + "eyes within reach; without aim it uses the current facing. Succeeds when the "
                + "game accepts the use. Food, Ender Eyes and Ender Pearls are refused: eat and "
                + "throw_eye_of_ender handle the first two. Items used on a block go through "
                + "use_item_on_block.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .optionalString("item_id", "Carried item to hold and use. Omitted = the item in hand.")
                .optionalObject("aim", "Known air cell to face, in the current dimension. Omitted = "
                        + "the current facing.", position ->
                        position.integer("x", "Block X")
                                .integer("y", "Block Y")
                                .integer("z", "Block Z"))
                .optionalInteger("hold_ticks", "Omitted or 0 = one click. A positive value holds the "
                        + "use for that many ticks, then releases it. -1 holds until the use ends on "
                        + "its own.", -1, 6000)
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer bot,
                             Consumer<String> reply) {
        Item item = args.has("item_id") ? ToolArgs.parseItem(ToolParse.string(args, "item_id")) : null;
        BlockPos aim = args.has("aim") ? ToolParse.position(ToolParse.object(args, "aim")) : null;
        int holdTicks = args.has("hold_ticks") ? ToolParse.integer(args, "hold_ticks") : 0;
        if (holdTicks < -1) throw new IllegalArgumentException("hold_ticks must be -1 or non-negative");
        runSync(bot, new UseItemTaskRecord(toolCallId,
                ctx(toolCallId, bot).deadline(TIMEOUT_TICKS), aim, holdTicks, item), reply);
    }
}
