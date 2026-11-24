package dev.mcagent.runtime.core.task.combat;

import dev.mcagent.runtime.task.TaskRecord;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Progress record for {@code attack}: the requested entity UUIDs, each UUID's final state, and strike counts.
 */
public final class AttackTaskRecord extends TaskRecord {

    public static final String TOOL_NAME = "attack";

    public final List<UUID> entityUuids;

    /**
     * No targets named: drive off all nearby hostile mobs.
     *
     * <p>This mode includes only the hostile mobs visible when the task starts and never grows. Offspring of
     * splitting mobs are outside the authorization; the model needs a new attack authorization to continue.
     */
    public final boolean indiscriminate;

    private final Set<UUID> defeated = new LinkedHashSet<>();
    private final Set<UUID> lost = new LinkedHashSet<>();
    private final Set<UUID> unreachable = new LinkedHashSet<>();
    private final Map<UUID, Integer> strikesByEntity = new LinkedHashMap<>();
    private int strikes;

    public AttackTaskRecord(String toolCallId, long deadlineGameTime,
                            List<UUID> entityUuids, boolean indiscriminate) {
        super(TOOL_NAME, toolCallId, deadlineGameTime);
        this.entityUuids = List.copyOf(entityUuids);
        this.indiscriminate = indiscriminate;
    }

    public Set<UUID> defeated() { return Set.copyOf(defeated); }
    public Set<UUID> lost() { return Set.copyOf(lost); }
    public Set<UUID> unreachable() { return Set.copyOf(unreachable); }
    public int strikes() { return strikes; }

    public void defeated(UUID uuid) { defeated.add(uuid); }
    public void lost(UUID uuid) { lost.add(uuid); }
    public void unreachable(UUID uuid) { unreachable.add(uuid); }

    /** One strike (a swing or an arrow shot). */
    public void strike(UUID uuid) {
        strikes++;
        strikesByEntity.merge(uuid, 1, Integer::sum);
    }

    public int strikes(UUID uuid) { return strikesByEntity.getOrDefault(uuid, 0); }

    public String status(UUID uuid) {
        if (defeated.contains(uuid)) return "defeated";
        if (lost.contains(uuid)) return "lost";
        if (unreachable.contains(uuid)) return "unreachable";
        return "pending";
    }

    public boolean terminal(UUID uuid) {
        return defeated.contains(uuid) || lost.contains(uuid) || unreachable.contains(uuid);
    }

    /**
     * One plain-language line <b>meant for a human reader</b>, as shown in task_status. The tool id is left out; the places that need it (the runtime state's tool attribute, the
     * dispatch receipt) already have it.
     */
    @Override
    public String describe() {
        return indiscriminate
                ? "clearing area, defeated " + defeated.size()
                : "fighting " + defeated.size() + "/" + entityUuids.size();
    }
}
