package dev.mcagent.runtime.core.tools.inventory;
import dev.mcagent.runtime.core.tools.ContainerOps;

import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/** Query tool (raw RuntimeTool): transfer items between slots in the open GUI; replies in place. */
public final class TransferTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }


    private static final Gson GSON = new Gson();
    private final ContainerOps impl = new ContainerOps();

    private record Args(Integer menu_id, Integer menu_revision, List<ContainerOps.Move> moves) {}

    @Override
    public String name() {
        return "transfer";
    }

    @Override
    public String description() {
        return "Move items between slots of the open block menu. moves run in order. A move without "
                + "to shifts the whole stack to the other side of the menu, as a shift-click does; with "
                + "to it places the stack, or count items of it, in that slot, merging with the same "
                + "item and swapping with a different one. menu_id and menu_revision come from "
                + "inspect_gui.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .integer("menu_id", "Exact open Menu id from inspect_gui.")
                .integer("menu_revision", "Exact open Menu revision from inspect_gui.")
                .objectArray("moves", "Transfers to run in order (one whole job per call).", item -> item
                        .integer("from", "Source slot index (from inspect_gui).")
                        .nullableInteger("to", "Destination slot. OMIT to route the stack to the other section "
                                + "(deposit/take/feed). Give a slot to place exactly there (empty=move, same "
                                + "item=merge, different item=swap).")
                        .nullableInteger("count", "Exact number to move (needs `to`; default = the whole stack). "
                                + "Ignored when `to` is omitted — routing moves the whole stack."))
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer self, Consumer<String> reply) {
        Args a = GSON.fromJson(args, Args.class);
        reply.accept(impl.transfer(a.menu_id(), a.menu_revision(), a.moves(), self));
    }
}
