package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.agent.tool.api.ToolContext;
import dev.mcagent.runtime.core.task.collect.CollectItemsTaskRecord;
import dev.mcagent.runtime.core.task.move.MoveToTaskRecord;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Locale;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class CanonicalSelectorOpsTest {

    private static final ToolContext CONTEXT = new ToolContext("test-call", 100L);

    @Test
    void collectionAcceptsOnlyGlobSelectors() {
        var ops = new InventoryOps();
        var glob = (CollectItemsTaskRecord) ops.collectItems(
                null, "minecraft:*_log", null, CONTEXT);
        assertTrue(glob.itemMatcher.matches("minecraft:oak_log"));
        assertFalse(glob.itemMatcher.matches("example:oak_log"));
        assertEquals("item_id_glob", glob.selectorField);
        assertEquals(8, glob.radius);

        UUID exactId = UUID.fromString("abcdefab-cdef-abcd-efab-cdefabcdefab");
        var exact = (CollectItemsTaskRecord) ops.collectItems(
                List.of(exactId.toString().toUpperCase(Locale.ROOT)), null, null, CONTEXT);
        assertEquals(java.util.Set.of(exactId), exact.exactUuids);
        assertEquals("uuids", exact.selectorField);
        assertEquals(8, exact.radius);

        assertThrows(IllegalArgumentException.class, () -> ops.collectItems(
                null, null, null, CONTEXT));
        assertThrows(IllegalArgumentException.class, () -> ops.collectItems(
                List.of(exactId.toString()), "minecraft:diamond", null, CONTEXT));
    }

    @Test
    void movementAcceptsOneGlobSelectorWithoutChangingCoordinateModes() {
        var ops = new MovementOps();
        var glob = (MoveToTaskRecord) ops.moveTo(
                null, null, null, null, "minecraft:*_log", null, null, CONTEXT);
        assertEquals(MoveToTaskRecord.Kind.FIND, glob.kind);
        assertEquals("minecraft:*_log", glob.selector());
        assertTrue(glob.usesGlob());

        var column = (MoveToTaskRecord) ops.moveTo(4.0, null, 9.0, null, null, null, null, CONTEXT);
        assertEquals(MoveToTaskRecord.Kind.COLUMN, column.kind);
        assertThrows(IllegalArgumentException.class, () -> ops.moveTo(
                null, null, null, "minecraft:.*_log", "minecraft:*_log", null, null, CONTEXT));
        assertThrows(IllegalArgumentException.class, () -> ops.moveTo(
                null, null, null, null, " minecraft:stone", null, null, CONTEXT));
        assertThrows(IllegalArgumentException.class, () -> ops.moveTo(
                null, null, null, null, "a".repeat(257), null, null, CONTEXT));
    }

    @Test
    void recipeLookupRejectsMissingOrUnsupportedGlobBeforeWorldAccess() {
        var ops = new QueryExtraOps();
        assertThrows(IllegalArgumentException.class,
                () -> ops.lookupRecipe(null, null));
        assertThrows(IllegalArgumentException.class,
                () -> ops.lookupRecipe("minecraft:(oak|birch)_planks", null));
    }
}
