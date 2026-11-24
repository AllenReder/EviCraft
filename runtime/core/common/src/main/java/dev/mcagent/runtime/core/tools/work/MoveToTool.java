package dev.mcagent.runtime.core.tools.work;
import dev.mcagent.runtime.core.tools.MovementOps;

import static dev.mcagent.runtime.task.TaskDispatch.*;

import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.core.tools.ToolParse;
import com.google.gson.JsonObject;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.List;
import java.util.function.Consumer;

/** Travel to one destination, named by an explicit goal object. */
public final class MoveToTool implements RuntimeTool {
    @Override
    public Execution execution() {
        return Execution.BODY;
    }

    private final MovementOps impl = new MovementOps();

    @Override
    public String name() {
        return "goto";
    }

    @Override
    public String description() {
        return "Travel to one destination. goal.kind selects it: column walks to x/z and resolves y to a "
                + "standable surface; cell stands in one exact feet cell, digging it out if needed, and "
                + "without exact may finish on a supported cell within 3 blocks; elevation climbs or "
                + "descends to y; block walks beside the easiest reachable known block matching "
                + "block_id_glob without damaging it. Paths are planned over known blocks only. "
                + "route_mutation_permissions limits what the route may do to the world: OPEN doors, "
                + "BREAK blocks, PLACE scaffold blocks; omitted means all three. Returns the final "
                + "position.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        Map<String, Object> schema = new LinkedHashMap<>(Schema.object()
                .optionalStringArray("route_mutation_permissions", "Route changes this call may make. "
                        + "Omitted = OPEN, BREAK and PLACE; an empty array permits none.")
                .build());
        @SuppressWarnings("unchecked")
        Map<String, Object> properties = (Map<String, Object>) schema.get("properties");
        @SuppressWarnings("unchecked")
        Map<String, Object> permissions =
                (Map<String, Object>) properties.get("route_mutation_permissions");
        @SuppressWarnings("unchecked")
        Map<String, Object> items = (Map<String, Object>) permissions.get("items");
        items.put("enum", List.of("OPEN", "BREAK", "PLACE"));
        permissions.put("maxItems", 3);
        permissions.put("uniqueItems", true);

        Map<String, Object> integer = Map.of("type", "integer");
        Map<String, Object> position = goalBranch(
                Map.of("x", integer, "y", integer, "z", integer), List.of("x", "y", "z"));
        Map<String, Object> goal = new LinkedHashMap<>();
        goal.put("description", "The destination, in the current dimension.");
        goal.put("oneOf", List.of(
                goalBranch(Map.of("kind", Map.of("const", "column"), "x", integer, "z", integer),
                        List.of("kind", "x", "z")),
                goalBranch(Map.of("kind", Map.of("const", "cell"), "position", position,
                                "exact", Map.of("type", "boolean", "description",
                                        "true fails unless this exact cell is reached.")),
                        List.of("kind", "position")),
                goalBranch(Map.of("kind", Map.of("const", "elevation"), "y", integer),
                        List.of("kind", "y")),
                goalBranch(Map.of("kind", Map.of("const", "block"), "block_id_glob",
                                Map.of("type", "string", "description",
                                        "Glob over known block ids; * and ? match any characters.")),
                        List.of("kind", "block_id_glob"))));
        properties.put("goal", goal);
        schema.put("required", List.of("goal"));
        return schema;
    }

    private static Map<String, Object> goalBranch(Map<String, Object> properties, List<String> required) {
        Map<String, Object> branch = new LinkedHashMap<>();
        branch.put("type", "object");
        branch.put("properties", new java.util.TreeMap<>(properties));
        branch.put("required", required);
        branch.put("additionalProperties", false);
        return branch;
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer bot, Consumer<String> reply) {
        JsonObject goal = ToolParse.object(args, "goal");
        List<String> permissions = args.has("route_mutation_permissions")
                && !args.get("route_mutation_permissions").isJsonNull()
                ? ToolParse.strings(args.getAsJsonArray("route_mutation_permissions")) : null;
        Double x = null, y = null, z = null;
        String glob = null;
        Boolean exact = null;
        switch (ToolParse.string(goal, "kind")) {
            case "column" -> {
                x = (double) ToolParse.integer(goal, "x");
                z = (double) ToolParse.integer(goal, "z");
            }
            case "cell" -> {
                var position = ToolParse.position(ToolParse.object(goal, "position"));
                x = (double) position.getX();
                y = (double) position.getY();
                z = (double) position.getZ();
                exact = goal.has("exact") && goal.get("exact").getAsBoolean();
            }
            case "elevation" -> y = (double) ToolParse.integer(goal, "y");
            case "block" -> glob = ToolParse.string(goal, "block_id_glob");
            default -> throw new IllegalArgumentException(
                    "goal.kind must be column, cell, elevation or block");
        }
        setTask(bot, impl.moveTo(x, y, z, null, glob, permissions, exact,
                ctx(toolCallId, bot)), args, reply);
    }
}
