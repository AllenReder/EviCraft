package dev.mcagent.runtime.core.tools;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class CombatOpsTest {

    @Test
    void normalizesEntityUuidsWithoutChangingTheirOrder() {
        UUID first = UUID.fromString("00000000-0000-0000-0000-000000000184");
        UUID second = UUID.fromString("00000000-0000-0000-0000-000000000207");
        UUID third = UUID.fromString("00000000-0000-0000-0000-000000000215");
        assertEquals(List.of(first, second, third), CombatOps.normalizeEntityUuids(List.of(
                first.toString(), second.toString(), first.toString(), third.toString())));
    }

    @Test
    void rejectsAnEmptyAuthorizedSet() {
        assertThrows(IllegalArgumentException.class,
                () -> CombatOps.normalizeEntityUuids(List.of()));
    }

    @Test
    void rejectsMoreThanTwentyDistinctTargets() {
        List<String> ids = new ArrayList<>();
        for (int id = 1; id <= 21; id++) ids.add(new UUID(0, id).toString());
        assertThrows(IllegalArgumentException.class,
                () -> CombatOps.normalizeEntityUuids(ids));
    }

    @Test
    void rejectsMalformedEntityUuid() {
        assertThrows(IllegalArgumentException.class,
                () -> CombatOps.normalizeEntityUuids(List.of("not-a-uuid")));
    }
}
