package dev.mcagent.runtime.core.tools.perception;

import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.core.pathing.settings.ScaffoldMaterials;
import dev.mcagent.runtime.core.tools.ScaffoldOps;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/** Immediate Runtime Tool for one World Run-scoped ordered Scaffold Material Glob policy. */
public final class ManageScaffoldMaterialsTool implements RuntimeTool {

    private static final Gson GSON = new Gson();
    @Override
    public Execution execution() {
        return Execution.BODY;
    }

    private final ScaffoldOps operations = new ScaffoldOps();

    private record Args(String action, List<String> item_id_globs) {}

    @Override
    public String name() {
        return "manage_scaffold_materials";
    }

    @Override
    public String description() {
        return "Read or change the ordered item-id globs that say which carried blocks navigation "
                + "may place to bridge, step up or pillar. read (the default) returns the list; add "
                + "appends; delete removes exact entries; set replaces the list; clear permits none. "
                + "The setting lasts until the server restarts.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        Map<String, Object> schema = new LinkedHashMap<>(Schema.object()
                .optionalEnum("action", "Omit for read.",
                        "read", "add", "delete", "set", "clear")
                .build());
        @SuppressWarnings("unchecked")
        Map<String, Object> properties = (Map<String, Object>) schema.get("properties");
        Map<String, Object> items = new LinkedHashMap<>();
        items.put("type", "string");
        items.put("pattern", "^[a-z0-9_.:/?*-]{1,256}$");
        Map<String, Object> globs = new LinkedHashMap<>();
        globs.put("type", "array");
        globs.put("description", "1-16 ordered Canonical ID Globs required by add, delete, and set.");
        globs.put("items", items);
        globs.put("minItems", 1);
        globs.put("maxItems", ScaffoldMaterials.MAX_GLOBS);
        properties.put("item_id_globs", globs);
        return schema;
    }

    @Override
    public void onServerCall(
            String toolCallId, JsonObject args, BotPlayer self, Consumer<String> reply) {
        Args parsed = GSON.fromJson(args, Args.class);
        reply.accept(operations.apply(
                parsed == null ? null : parsed.action(),
                parsed == null ? null : parsed.item_id_globs(),
                self));
    }
}
