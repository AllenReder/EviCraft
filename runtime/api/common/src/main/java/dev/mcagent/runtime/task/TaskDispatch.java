package dev.mcagent.runtime.task;

import dev.mcagent.runtime.agent.tool.api.ToolContext;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;

import java.util.function.Consumer;

/**
 * Three static helpers body tools use in {@code onServerCall} (static import them and keep the call
 * sites bare): {@link #ctx} builds the context, {@link #runSync} makes the turn wait, and
 * {@link #setTask} replaces what the Bot is currently doing.
 *
 * <h2>Choosing a path (the single source of truth for tool authors)</h2>
 * <ul>
 *   <li><b>Does not use the body</b> (pure query / UI / external service / bookkeeping such as
 *       {@code set_timer}) → stays out of the task system; invoke completes on the spot;</li>
 *   <li><b>Uses the body, short and bounded</b> (guaranteed done within a few seconds at worst, with a
 *       fixed deadline that never fails it unfairly) → {@link #runSync}: the turn waits for the result,
 *       which is short enough to be worth waiting for;</li>
 *   <li><b>Uses the body, unbounded</b> (duration depends on the world: distance, resources, enemies)
 *       → {@link #setTask}: acknowledged on acceptance, finished through a task_finished event. A
 *       serial tool dispatcher must not freeze a whole turn for minutes of work.</li>
 * </ul>
 *
 * <h2>Standing tasks are not another path</h2>
 * "Fish forever" and "catch 64 fish" go through the <b>same</b> {@link #setTask}. The only difference is
 * whether the task's {@code tick()} returns a terminal state: given a {@code count} it returns SUCCESS
 * and frees the slot; without one it stays RUNNING in the slot until replaced. A tool author writes the
 * fishing logic once and gets both uses.
 *
 * <p>There is no fourth path. Bidding chains belong to reflexes and tools cannot enter them: chains are
 * registered globally, carried by every Bot, take no parameters and cannot be switched, so a
 * parameterized tool call cannot attach to one.
 */
public final class TaskDispatch {

    private TaskDispatch() {}

    /** Task context: the call id plus the body's current game tick (the start of the deadline). */
    public static ToolContext ctx(String toolCallId, BotPlayer bot) {
        return new ToolContext(toolCallId, bot.level().getGameTime());
    }

    /**
     * Synchronous action: the turn waits until it finishes. <b>No acknowledgement</b>: the result is sent
     * when the task settles, so the client's strictly serial tool dispatcher naturally runs the
     * synchronous actions of one batch one after another; no queue is needed here and they never collide.
     *
     * <p>It ranks <b>above the current task</b> (see {@link TaskSelector}): someone is waiting on it, while
     * the long job at the head may take minutes, so ranking it below would stall the conversation until
     * its deadline. Being short and bounded, it cannot starve anything by going first.
     */
    public static void runSync(BotPlayer bot, TaskRecord record, Consumer<String> reply) {
        BotTickDispatcher.syncSlotFor(bot.getUUID()).put(bot, record);
    }

    /**
     * Replaces what the Bot is currently doing: acknowledges with a task_id on acceptance, runs on the body
     * in the background, and reports completion through task_finished.
     *
     * <p>The task already in the slot is <b>replaced</b> (it receives a cancelled result); the new one is
     * not refused. Changing one's mind is normal, and ignoring a new request because the Bot is busy mining
     * would be the most visible way to break the interaction.
     *
     * <p><b>The only refusal</b>: the slot holds a task accepted in the same batch of tool calls that has
     * not run a single tick. That means the model dispatched two jobs in one turn; it should get the first
     * result and assess the situation before deciding the next step, not commit blindly. This is decidable
     * locally ({@link TaskRecord#acceptedThisTick}), with no need to pass a turn id to the server.
     */
    public static void setTask(BotPlayer bot, TaskRecord record, JsonObject args,
                               Consumer<String> reply) {
        java.util.UUID id = bot.getUUID();
        if (BotTickDispatcher.currentFreshlyAccepted(bot)) {
            TaskRecord busy = BotTickDispatcher.currentTaskFor(id);
            // A standing task never sends task_finished; telling the model to wait for it would point at an
            // event that never comes.
            boolean busyStanding = busy.getDeadlineGameTime() >= TaskRecord.NO_DEADLINE;
            reply.accept(TaskResult.fail("The body does one thing at a time. " + busy.publicId()
                    + "(" + busy.describe() + ") was accepted just this moment"
                    + (busyStanding
                        ? "; it is a standing task and will not send task_finished. "
                        : "; wait for its task_finished. ")
                    + "Get its result and check the situation before deciding the next step; "
                    + "to switch, dispatch a new task next turn.", "busy").toJson());
            return;
        }
        record.markAsync();
        BotTickDispatcher.currentSlotFor(id).put(bot, record);
        // The built-in brain finishes on the task_finished event (no polling). An external (MCP) controller
        // does not receive that event (it goes to the built-in brain), so it must poll task_status until the
        // body is idle, then confirm by perception. A standing task has no end and never sends
        // task_finished; the acknowledgement must say so, or the Bot would wait for the event forever.
        boolean standing = record.getDeadlineGameTime() >= TaskRecord.NO_DEADLINE;
        String note;
        if (standing) {
            note = "Accepted, ongoing. This task has no end and will not send a task_finished event; "
                    + "dispatching another body action replaces it, which is the normal way to stop it.";
        } else if (record.isExternalCall()) {
            note = "Accepted, running in the background. Poll with task_status; the body turning idle means done, then confirm the result with perception tools; task_stop to stop.";
        } else {
            note = "Accepted, running in the background. A task_finished event arrives automatically on completion, do not poll; task_status for progress, task_stop to stop.";
        }
        reply.accept(TaskResult.ok(
                note,
                java.util.Map.of(
                        "task_id", record.publicId(),
                        "task", record.getToolName(),
                        "async", true,
                        "standing", standing)).toJson());
    }
}
