package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.core.pathing.settings.ScaffoldMaterials;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskResult;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Applies one atomic read or mutation to a Runtime Bot's World Run Scaffold Material policy. */
public final class ScaffoldOps {

    private static final int EFFECTIVE_SAMPLE_LIMIT = 16;

    public String apply(String action, List<String> itemIdGlobs, BotPlayer self) {
        String requestedAction = action == null ? "read" : action;
        Action operation = Action.fromWireName(requestedAction);
        if (operation == null) {
            return failure(self, requestedAction, "invalid_action",
                    "unknown action '" + requestedAction + "'; use read, add, delete, set, or clear");
        }
        try {
            switch (operation) {
                case READ -> { }
                case CLEAR -> ScaffoldMaterials.store(self, List.of());
                case ADD -> {
                    requirePatterns(operation.wireName(), itemIdGlobs);
                    List<String> merged = new ArrayList<>(ScaffoldMaterials.storedGlobs(self));
                    merged.addAll(itemIdGlobs);
                    ScaffoldMaterials.store(self, merged);
                }
                case DELETE -> {
                    requirePatterns(operation.wireName(), itemIdGlobs);
                    List<String> exact = ScaffoldMaterials.validateGlobs(itemIdGlobs);
                    List<String> kept = new ArrayList<>(ScaffoldMaterials.storedGlobs(self));
                    kept.removeIf(exact::contains);
                    ScaffoldMaterials.store(self, kept);
                }
                case SET -> {
                    requirePatterns(operation.wireName(), itemIdGlobs);
                    ScaffoldMaterials.store(self, itemIdGlobs);
                }
            }
        } catch (MissingPatterns failure) {
            return failure(self, operation.wireName(), "missing_item_id_globs", failure.getMessage());
        } catch (ScaffoldMaterials.PolicyException failure) {
            return failure(self, operation.wireName(),
                    failureType(failure.failureType()), failure.getMessage());
        }
        return TaskResult.ok(operation.successMessage(),
                projection(self, operation.wireName())).toJson();
    }

    private static void requirePatterns(String action, List<String> itemIdGlobs) {
        if (itemIdGlobs == null || itemIdGlobs.isEmpty()) {
            throw new MissingPatterns(action + " requires a non-empty item_id_globs list");
        }
    }

    private static String failure(
            BotPlayer self, String action, String failureType, String message) {
        Map<String, Object> data = new LinkedHashMap<>(projection(self, action));
        data.put("failure_type", failureType);
        return TaskResult.fail(message, data).toJson();
    }

    private static Map<String, Object> projection(BotPlayer self, String action) {
        List<String> effectiveIds = ScaffoldMaterials.effectiveIds(self);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("action", action);
        data.put("item_id_globs", ScaffoldMaterials.storedGlobs(self));
        data.put("effective_item_count", effectiveIds.size());
        data.put("effective_item_sample",
                effectiveIds.subList(0, Math.min(EFFECTIVE_SAMPLE_LIMIT, effectiveIds.size())));
        data.put("carried_matching_items", carriedMatchingItems(self));
        return data;
    }

    private static List<Map<String, Object>> carriedMatchingItems(BotPlayer self) {
        List<Item> effective = ScaffoldMaterials.of(self);
        Set<Item> accepted = new LinkedHashSet<>(effective);
        Map<Item, Integer> counts = new LinkedHashMap<>();
        var inventory = self.getInventory();
        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (!stack.isEmpty() && accepted.contains(stack.getItem())) {
                counts.merge(stack.getItem(), stack.getCount(), Integer::sum);
            }
        }
        List<Map<String, Object>> carried = new ArrayList<>();
        for (Item item : effective) {
            Integer count = counts.get(item);
            if (count == null) continue;
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("item_id", ScaffoldMaterials.idOf(item));
            entry.put("count", count);
            carried.add(entry);
        }
        return List.copyOf(carried);
    }

    private static String failureType(ScaffoldMaterials.FailureType type) {
        return switch (type) {
            case INVALID_ITEM_ID_GLOB -> "invalid_item_id_glob";
            case NO_BLOCK_ITEM_MATCH -> "no_block_item_match";
            case TOO_MANY_ITEM_ID_GLOBS -> "too_many_item_id_globs";
            case TOO_MANY_EFFECTIVE_ITEMS -> "too_many_effective_items";
        };
    }

    private enum Action {
        READ("read", "current Scaffold Material consumption policy"),
        ADD("add", "Scaffold Material consumption policy updated atomically"),
        DELETE("delete", "Scaffold Material consumption policy updated atomically"),
        SET("set", "Scaffold Material consumption policy updated atomically"),
        CLEAR("clear", "Scaffold Material consumption is disabled for this World Run");

        private final String wireName;
        private final String successMessage;

        Action(String wireName, String successMessage) {
            this.wireName = wireName;
            this.successMessage = successMessage;
        }

        private String wireName() {
            return wireName;
        }

        private String successMessage() {
            return successMessage;
        }

        private static Action fromWireName(String wireName) {
            for (Action action : values()) {
                if (action.wireName.equals(wireName)) return action;
            }
            return null;
        }
    }

    private static final class MissingPatterns extends IllegalArgumentException {
        private MissingPatterns(String message) {
            super(message);
        }
    }
}
