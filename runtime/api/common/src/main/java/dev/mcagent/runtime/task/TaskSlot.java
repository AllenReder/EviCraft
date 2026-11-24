package dev.mcagent.runtime.task;

import dev.mcagent.runtime.entity.BotPlayer;

import java.util.function.Consumer;

/**
 * A place that holds one task. A body has exactly two: one for the synchronous action, one for the
 * current task.
 *
 * <p><b>It only holds a task</b>: {@link TaskSelector} decides who gets the body, and the task manages
 * its own progress and settlement.
 *
 * <h2>Why preemption does not settle</h2>
 * A task settles only when it reaches a terminal state <b>while being ticked itself</b> (build result →
 * outbox → free the slot). Preemption by a reflex never settles, so a task that was preempted and resumed
 * still sends <b>exactly one</b> result, the one the client's tool_call waits for. {@link #freeze} pushes
 * the deadline back one tick for each preempted tick, so the task is not timed out unfairly while
 * something else holds the body.
 */
final class TaskSlot {

    private final Consumer<TaskRecord> outbox;

    private Task task;
    private TaskRecord record;

    TaskSlot(Consumer<TaskRecord> outbox) {
        this.outbox = outbox;
    }

    boolean isEmpty() {
        return record == null;
    }

    /**
     * Just accepted: the tick of acceptance has not passed yet.
     *
     * <p>Separates two kinds of "dispatch another job": the second one in the same batch of tool calls
     * (the model is planning; refuse it so the model sees the first result before deciding), and one from
     * a new turn (the user or model changed its mind; replace). Decidable locally, with no need to pass a
     * turn id to the server.
     *
     * <p><b>It measures how long the record has been in the slot, not how long the task has run.</b>
     * Tasks go dormant: {@code follow} returns false from {@code canRun} while next to its target, so the
     * slot is not ticked. With run time as the criterion, a follow task running for ten minutes would
     * still count as just accepted, every request to pick up a drop would be refused, and the refusal would
     * tell the model to wait for a {@code task_finished} that a standing task never sends.
     *
     * <p>The record knows its own acceptance tick, so the criterion lives there
     * ({@link TaskRecord#acceptedThisTick}).
     */
    boolean freshlyAccepted(BotPlayer bot) {
        return record != null && record.acceptedThisTick(bot.level().getGameTime());
    }

    TaskRecord record() {
        return record;
    }

    /** Whether the task in the slot can run now; false for an empty slot. */
    boolean canRun(BotPlayer bot) {
        return record != null && record.getState() == TaskState.RUNNING && task.canRun(bot);
    }

    /**
     * Puts a new task in. The previous one settles as <b>replaced</b> and its result is sent; it must not
     * vanish silently, because the model holds its tool_call, which either gets a result or hangs forever.
     */
    void put(BotPlayer bot, TaskRecord rec) {
        if (record != null) {
            task.stop(bot, Task.StopReason.REPLACED);
            if (!record.getState().isTerminal()) {
                record.setState(TaskState.CANCELLED);
            }
            settle();
        }
        rec.setState(TaskState.RUNNING);
        rec.markStarted(bot.level().getGameTime());
        task = TaskFactory.create(bot, rec);
        record = rec;
        task.start(bot);
        // A task that is already terminal after start() (a one-shot action that finished, or a failed
        // precondition) settles at once instead of sitting RUNNING for a tick, where a stop request would
        // interrupt work that is already done.
        settleIfTerminal();
    }

    /** Advance one tick: check the deadline, run one tick, settle when terminal. */
    void tick(BotPlayer bot) {
        if (record == null) {
            return;
        }
        if (record.getState() == TaskState.RUNNING) {
            if (bot.level().getGameTime() >= record.getDeadlineGameTime()) {
                record.setState(TaskState.TIMEOUT);
            } else {
                record.setState(task.tick(bot));
            }
        }
        settleIfTerminal();
    }

    /** Lose the body without discarding the task: used on preemption; all state is kept for the resume. */
    void loseBody(BotPlayer bot) {
        if (task != null) {
            task.stop(bot, Task.StopReason.PREEMPTED);
        }
    }

    /** A preempted tick is not charged to the task: the deadline moves one tick later (never earlier). */
    void freeze() {
        if (record != null && record.getState() == TaskState.RUNNING) {
            record.extendDeadlineTo(record.getDeadlineGameTime() + 1);
        }
    }

    /**
     * Settle when terminal. <b>Call every tick</b>, even when another slot holds the body: a stop request
     * marks the record CANCELLED out of band, and the client's strictly serial tool dispatcher blocks until
     * that result is sent, so settlement cannot wait until this slot wins again.
     */
    void settleIfTerminal() {
        if (record != null && record.getState().isTerminal()) {
            settle();
        }
    }

    /** Stop request: mark as cancelled; the next settlement sends the result. */
    void cancel() {
        if (record != null && record.getState() == TaskState.RUNNING) {
            record.setState(TaskState.CANCELLED);
        }
    }

    /** Cancel and settle at a server stable point, even when game ticks are paused. */
    void cancelAndSettle(BotPlayer bot) {
        if (record == null) return;
        if (record.getState() == TaskState.RUNNING) {
            record.setState(TaskState.CANCELLED);
            settle(bot, true);
        } else {
            settleIfTerminal();
        }
    }

    /** The body is leaving the world: settle in place (it will not be ticked again) so cleanup runs and the
     * result is sent. */
    void finalizeInline() {
        if (record == null) {
            return;
        }
        if (!record.getState().isTerminal()) {
            record.setState(TaskState.CANCELLED);
        }
        settle();
    }

    /**
     * Death drops the disabled owner's task without a duplicate result, but a Runtime SDK call
     * has no separate death payload and must receive one ordinary interrupted terminal result.
     */
    void dropOnDeath(BotPlayer bot) {
        if (record != null && record.getToolCallId() != null
                && record.getToolCallId().startsWith(TaskRecord.RUNTIME_CALL_PREFIX)) {
            if (!record.getState().isTerminal()) {
                record.setState(TaskState.CANCELLED);
            }
            settle();
            return;
        }
        task = null;
        record = null;
    }

    private void settle() {
        settle(null, false);
    }

    private void settle(BotPlayer bot, boolean stopBody) {
        Task finishedTask = task;
        TaskRecord finishedRecord = record;
        // Relinquish slot ownership before callbacks can fail or re-enter.
        task = null;
        record = null;
        RuntimeException stopFailure = null;
        if (stopBody) {
            try {
                finishedTask.stop(bot, Task.StopReason.REPLACED);
            } catch (RuntimeException exception) {
                stopFailure = exception;
                dev.mcagent.runtime.Constants.LOG.error("Task cancellation stop failed: {}",
                        finishedRecord.getToolName(), exception);
            }
        }
        try {
            TaskResult result = finishedTask.result(finishedRecord.getState());
            finishedRecord.setResult(result != null ? result : TaskResult.fail("task produced no result"));
        } catch (RuntimeException exception) {
            dev.mcagent.runtime.Constants.LOG.error("Task terminal result failed: {}", finishedRecord.getToolName(), exception);
            finishedRecord.setResult(new TaskResult(false, "task terminal result failed",
                    finishedRecord.getState() == TaskState.TIMEOUT,
                    finishedRecord.getState() == TaskState.CANCELLED,
                    java.util.Map.of("failure_type", "internal")));
        }
        if (stopFailure != null) {
            TaskResult result = finishedRecord.getResult();
            var data = new java.util.HashMap<>(result.data());
            data.put("failure_type", "internal");
            finishedRecord.setResult(new TaskResult(false,
                    result.message() + "; task cancellation stop failed: " + stopFailure,
                    result.timedOut(), true, data));
        }
        outbox.accept(finishedRecord);
    }
}
