package dev.mcagent.runtime.core.tools.inventory;
import dev.mcagent.runtime.core.tools.QueryExtraOps;

import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.function.Consumer;

/** Query tool (raw RuntimeTool): look up how to make an item (JEI-style). */
public final class LookupRecipeTool implements RuntimeTool {

    private static final Gson GSON = new Gson();
    private final QueryExtraOps impl = new QueryExtraOps();

    private record Args(
            String recipe_or_output_id_glob) {}

    @Override
    public String name() {
        return "lookup_recipe";
    }

    @Override
    public String description() {
        return "Look up recipes by one glob over recipe ids or output item ids. Returns up to four "
                + "matches across crafting (with the grid layout), smelting, blasting, smoking, "
                + "stonecutting and smithing, each labelled with its station.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.object()
                .optionalString("recipe_or_output_id_glob", "Bounded full-match Canonical ID Glob "
                        + "over recipe or output item ids, e.g. minecraft:*_from_smelting_*.")
                .build();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer self, Consumer<String> reply) {
        Args a = GSON.fromJson(args, Args.class);
        reply.accept(impl.lookupRecipe(
                a.recipe_or_output_id_glob(), self));
    }
}
