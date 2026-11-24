package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.agent.tool.api.ToolContext;
import dev.mcagent.runtime.core.task.combat.AttackTaskRecord;
import dev.mcagent.runtime.task.TaskRecord;

import java.util.List;
import java.util.UUID;

/** Builds the task record for {@code attack}. */
public final class CombatOps {

    /** Time budget per target; the total is capped at ten minutes. */
    private static final long PER_TARGET_TICKS = 75L * 20L;
    private static final long MIN_TICKS = 120L * 20L;
    private static final long MAX_TICKS = 10L * 60L * 20L;

    /**
     * {@code uuids=null} means <b>indiscriminate</b>: attack the hostile mobs visible when the task starts.
     * The target set is frozen at start and never grows. Offspring of splitting mobs need a new authorization.
     */
    public TaskRecord attack(List<String> entityUuids, ToolContext ctx) {
        boolean indiscriminate = entityUuids == null;
        List<UUID> uuids = indiscriminate ? List.of() : normalizeEntityUuids(entityUuids);
        long count = indiscriminate ? 4 : uuids.size();
        long timeout = Math.min(MAX_TICKS, Math.max(MIN_TICKS, count * PER_TARGET_TICKS));
        return new AttackTaskRecord(ctx.toolCallId(), ctx.deadline(timeout), uuids, indiscriminate);
    }

    static List<UUID> normalizeEntityUuids(List<String> entityUuids) {
        if (entityUuids == null) throw new IllegalArgumentException("uuids is required");
        List<UUID> uuids = entityUuids.stream()
                .filter(java.util.Objects::nonNull)
                .map(value -> {
                    try {
                        return UUID.fromString(value);
                    } catch (IllegalArgumentException invalid) {
                        throw new IllegalArgumentException("uuids contains an invalid UUID: " + value);
                    }
                })
                .distinct()
                .toList();
        if (uuids.isEmpty()) {
            throw new IllegalArgumentException("uuids contained no entity UUIDs");
        }
        if (uuids.size() > 20) {
            throw new IllegalArgumentException("uuids accepts at most 20 distinct UUIDs");
        }
        return uuids;
    }
}
