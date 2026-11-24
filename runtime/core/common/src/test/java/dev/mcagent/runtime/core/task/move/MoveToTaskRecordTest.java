package dev.mcagent.runtime.core.task.move;

import dev.mcagent.runtime.core.pathing.execute.RouteMutation;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MoveToTaskRecordTest {

    @Test
    void omittedPermissionsPreserveFullTraversal() {
        MoveToTaskRecord record = record(null);

        assertTrue(record.routeMutations.permits(RouteMutation.Kind.OPEN));
        assertTrue(record.routeMutations.permits(RouteMutation.Kind.BREAK));
        assertTrue(record.routeMutations.permits(RouteMutation.Kind.PLACE));
    }

    @Test
    void explicitPermissionsNarrowTheTaskScopedPolicy() {
        MoveToTaskRecord empty = record(List.of());
        MoveToTaskRecord openOnly = record(List.of("OPEN"));

        assertFalse(empty.routeMutations.permits(RouteMutation.Kind.OPEN));
        assertFalse(empty.routeMutations.permits(RouteMutation.Kind.BREAK));
        assertFalse(empty.routeMutations.permits(RouteMutation.Kind.PLACE));
        assertTrue(openOnly.routeMutations.permits(RouteMutation.Kind.OPEN));
        assertFalse(openOnly.routeMutations.permits(RouteMutation.Kind.BREAK));
        assertFalse(openOnly.routeMutations.permits(RouteMutation.Kind.PLACE));
    }

    @Test
    void invalidPermissionNamesAreOrdinaryInputErrors() {
        assertThrows(IllegalArgumentException.class, () -> record(List.of("FLY")));
        assertThrows(IllegalArgumentException.class, () -> record(List.of("BREAK", "BREAK")));
    }

    @Test
    void exactArrivalIsOptInForFeetCellDestinationsOnly() {
        assertFalse(record(null).exact);
        assertFalse(new MoveToTaskRecord(
                "call", 100L, 4.0, 64.0, -2.0, null, null, null, null).exact);
        assertTrue(new MoveToTaskRecord(
                "call", 100L, 4.0, 64.0, -2.0, null, null, null, true).exact);
        assertThrows(IllegalArgumentException.class, () -> new MoveToTaskRecord(
                "call", 100L, 4.0, null, -2.0, null, null, null, true));
        assertThrows(IllegalArgumentException.class, () -> new MoveToTaskRecord(
                "call", 100L, null, 12.0, null, null, null, null, true));
        assertThrows(IllegalArgumentException.class, () -> new MoveToTaskRecord(
                "call", 100L, null, null, null, null, "minecraft:*_log", null, true));
    }

    private static MoveToTaskRecord record(List<String> permissions) {
        return new MoveToTaskRecord(
                "call", 100L, 4.0, null, -2.0, null, null, permissions, null);
    }
}
