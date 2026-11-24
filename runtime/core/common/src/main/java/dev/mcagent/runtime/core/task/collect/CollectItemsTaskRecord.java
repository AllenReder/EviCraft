package dev.mcagent.runtime.core.task.collect;

import dev.mcagent.runtime.task.TaskRecord;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierMatcher;

import java.util.Set;
import java.util.UUID;

/**
 * Typed descriptor for evidence-bound {@code collect_items}. Exactly one selector is present:
 * 1-64 exact dropped-item Entity Track UUIDs or one canonical item-id full-match selector.
 */
public final class CollectItemsTaskRecord extends TaskRecord {

    public static final String TOOL_NAME = "collect_items";

    public final Set<UUID> exactUuids;
    public final CanonicalIdentifierMatcher itemMatcher;
    public final String selector;
    public final String selectorField;
    /** Search radius in blocks. */
    public final int radius;
    private int collectedEntities;
    private int collectedItems;
    private int skippedEntities;
    private int lostEntities;
    private int unreachableEntities;

    public CollectItemsTaskRecord(String toolCallId, long deadlineGameTime,
                                  Set<UUID> exactUuids,
                                  CanonicalIdentifierMatcher itemMatcher,
                                  String selector,
                                  String selectorField,
                                  int radius) {
        super(TOOL_NAME, toolCallId, deadlineGameTime);
        this.exactUuids = Set.copyOf(exactUuids);
        this.itemMatcher = itemMatcher;
        this.selector = selector;
        this.selectorField = selectorField;
        this.radius = radius;
    }

    public int collectedEntities() {
        return collectedEntities;
    }

    public int collectedItems() {
        return collectedItems;
    }

    public int skippedEntities() {
        return skippedEntities;
    }

    public int lostEntities() {
        return lostEntities;
    }

    public int unreachableEntities() {
        return unreachableEntities;
    }

    public void recordPickup(int itemCount, boolean complete) {
        if (complete) collectedEntities++;
        collectedItems += itemCount;
    }

    public void recordLostSkip() {
        skippedEntities++;
        lostEntities++;
    }

    public void recordUnreachableSkip() {
        skippedEntities++;
        unreachableEntities++;
    }

    @Override
    /**
     * One plain-language line <b>meant for a human reader</b>, as shown in task_status. The tool id is left out; the places that need it (the runtime state's tool attribute, the
     * dispatch receipt) already have it.
     */
    public String describe() {
        return TOOL_NAME + " " + (itemMatcher == null
                ? exactUuids.size() + " UUID(s)" : selector)
                + " x" + collectedEntities;
    }
}
