package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.agent.tool.api.ToolContext;
import dev.mcagent.runtime.task.TaskRecord;
import dev.mcagent.runtime.core.task.move.MoveToTaskRecord;

import java.util.List;

/**
 * Movement tool implementation — the business half of {@code MoveToTool}
 * ({@code goto}): its only job is to validate args and build the
 * {@link TaskRecord} the body's task queue runs (the {@link ToolContext}
 * carries the call id and deadline basis).
 */
public final class MovementOps {

    /** Base budget: 30 seconds at vanilla 20 tps (the goal extends it by distance at runtime). */
    private static final long DEFAULT_TIMEOUT_TICKS = 30 * 20;

    public TaskRecord moveTo(
Double x,
Double y,
Double z,
            String block,
            String blockIdGlob,
            List<String> routeMutationPermissions,
            Boolean exact,
            ToolContext ctx) {
        // MoveToTaskRecord validates the x/y/z/block combination, throwing a
        // teaching error for an ambiguous one (e.g. only x given, or block
        // combined with coordinates).
        return new MoveToTaskRecord(ctx.toolCallId(), ctx.deadline(DEFAULT_TIMEOUT_TICKS),
                x, y, z, block, blockIdGlob, routeMutationPermissions, exact);
    }
}
