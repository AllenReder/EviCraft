package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.agent.tool.ToolArgs;
import dev.mcagent.runtime.agent.tool.api.ToolContext;
import dev.mcagent.runtime.task.TaskRecord;
import dev.mcagent.runtime.core.task.interact.InteractEntityTaskRecord;

import java.util.UUID;

/**
 * Implementation of {@code InteractEntityTool}: validates the arguments and builds the
 * {@link TaskRecord}; the {@link ToolContext} carries the call id and deadline basis.
 */
public final class BlockActionOps {

    // interact_entity: covers chasing a moving target.
    private static final long INTERACT_ENTITY_TIMEOUT_TICKS = 60 * 20;

    public TaskRecord interactEntity(
            String uuid,
            Integer hold_ticks,
            String item_id,
            ToolContext ctx) {
        UUID entityUuid;
        try {
            entityUuid = UUID.fromString(uuid);
        } catch (RuntimeException exception) {
            throw new IllegalArgumentException("uuid must be an exact Entity Track UUID");
        }
        int holdTicks = hold_ticks == null ? 0 : hold_ticks;
        if (holdTicks < -1) {
            throw new IllegalArgumentException(
                    "hold_ticks must be -1 or non-negative; every hold is bounded by the task timeout");
        }
        return new InteractEntityTaskRecord(ctx.toolCallId(),
                ctx.deadline(INTERACT_ENTITY_TIMEOUT_TICKS), entityUuid, holdTicks,
                item_id == null ? null : ToolArgs.parseItem(item_id));
    }
}
