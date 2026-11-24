package dev.mcagent.runtime.task;
import dev.mcagent.runtime.task.TaskResult;

/**
 * Placeholder for a record type with no registered executor. Fails with a clear
 * message so the LLM gets a real answer instead of a hang.
 */
@dev.mcagent.runtime.api.Internal
public final class UnsupportedTask implements Task {

    private final String toolName;

    public UnsupportedTask(TaskRecord record) {
        this.toolName = record.getToolName();
    }

    @Override
    public void start(dev.mcagent.runtime.entity.BotPlayer bot) {
        // nothing — fails on the first tick
    }

    @Override
    public TaskState tick(dev.mcagent.runtime.entity.BotPlayer bot) {
        return TaskState.FAILED;
    }

    @Override
    public TaskResult result(TaskState finalState) {
        return TaskResult.fail(toolName + " is not available on the bot yet "
                + "(it's mid-migration to the new player body)");
    }

    @Override
    public void stop(dev.mcagent.runtime.entity.BotPlayer bot, StopReason why) {
    }

    @Override
    public String name() {
        return "unsupported";
    }
}
