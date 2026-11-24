package dev.mcagent.runtime.task;

import dev.mcagent.runtime.entity.BotPlayer;

/**
 * Which slot holds the body this tick: the synchronous action first, then the current task.
 *
 * <p>A task that cannot run now ({@link Task#canRun} is false) yields the body without failing and
 * takes it back once it can run again.
 *
 * <p>Pure selection; the caller applies preemption by comparing the old and new winner.
 */
public final class TaskSelector {

    private TaskSelector() {}

    /**
     * The task that holds the body this tick, or {@code null} when neither can run.
     *
     * @param sync    the synchronous action a turn waits on, or null
     * @param current the current task slot, or null when empty
     */
    public static Task select(Task sync, Task current, BotPlayer bot) {
        if (sync != null && sync.canRun(bot)) {
            return sync;
        }
        if (current != null && current.canRun(bot)) {
            return current;
        }
        return null;
    }
}
