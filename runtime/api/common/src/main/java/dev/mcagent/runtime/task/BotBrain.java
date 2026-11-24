package dev.mcagent.runtime.task;

import dev.mcagent.runtime.entity.BotPlayer;

import java.util.ArrayDeque;
import java.util.Deque;

/**
 * The scheduler of one body: the value {@code BotTickDispatcher} stores per UUID.
 *
 * <p>Each tick it asks {@link TaskSelector} which slot holds the body (the synchronous
 * slot before the current task), then delivers the settled results.
 */
final class BotBrain {

    /** Settled records waiting to be delivered. */
    private final Deque<TaskRecord> outbox = new ArrayDeque<>();

    /** The synchronous action a turn waits on. */
    final TaskSlot sync = new TaskSlot(outbox::addLast);
    /** What the Bot is doing now: fishing, following, mining 64 blocks. Standing or one-shot depends only on
     * whether tick returns a terminal state. */
    final TaskSlot current = new TaskSlot(outbox::addLast);

    /** The body this brain serves. Bound on the first tick and never changed. */
    private BotPlayer body;

    /** Last tick's winner, so it is told it lost the body at the moment of the switch, not every tick. */
    private Task holder;

    /**
     * Whether this is still the same body.
     *
     * <p>The Bot's UUID can stay the same across saves while the body instance is new. Tasks keep their
     * body ({@code AbstractBotTask.player} is final), so a brain <b>must not be reused across bodies</b>:
     * an old task would read blocks through the old {@code ServerLevel}, whose recorded main thread has
     * ended, and {@code getChunk} would submit work to a queue that nothing drains and then
     * {@code join()}. The new Server thread would park forever and the world would never load.
     *
     * <p>Normally a server stop discards the whole table ({@code ServerLifecycle}) before this is reached.
     * This check is the invariant itself: if some static table is ever missed, the worst case is a rebuilt
     * brain, not a deadlocked server thread.
     */
    boolean boundTo(BotPlayer bot) {
        return body == null || body == bot;
    }

    /** The bound body has left the world; only then should the brain be replaced. */
    boolean boundBodyGone() {
        return body == null || body.isRemoved();
    }

    void tick(BotPlayer bot) {
        body = bot;
        Task winner = TaskSelector.select(slotTask(sync, bot), slotTask(current, bot), bot);

        if (holder != null && holder != winner) {
            holder.stop(bot, Task.StopReason.PREEMPTED);
        }
        holder = winner;

        // A slot that did not win spends no budget this tick: the body being held elsewhere is not its fault.
        if (winner != syncProxy) {
            sync.freeze();
        }
        if (winner != currentProxy) {
            current.freeze();
        }

        if (winner == syncProxy) {
            sync.tick(bot);
        } else if (winner == currentProxy) {
            current.tick(bot);
        } else if (winner != null) {
            winner.tick(bot);
        }

        // Settle every tick: a stop request marks a record terminal out of band, and the client's serial
        // dispatcher blocks until that result is sent, so settlement cannot wait until the slot wins again.
        sync.settleIfTerminal();
        current.settleIfTerminal();
        // Order matters; do not swap: settle the slot state first, then announce the results.
        //
        // A task_finished result starts a turn <b>synchronously</b>, and building that request reads
        // <current_task>. Announcing first would hand the turn the last pushed progress snapshot (rate
        // limited, so possibly far behind), and the Bot would still treat the finished task as active.
        //
        // Both messages are sent in call order within one tick and arrive in that order, so this is not an
        // occasional race: announcing first is wrong <b>every</b> time. Clearing first means the turn
        // reads an empty slot.
        shipResults(bot);
    }

    /** Death drops the running tasks. */
    void dropActiveOnDeath(BotPlayer bot) {
        sync.dropOnDeath(bot);
        current.dropOnDeath(bot);
        holder = null;
        // Runtime SDK calls need a terminal TaskResult because that transport has no separate
        // death payload. Other calls keep the no-duplicate-result behavior.
        shipResults(bot);
        // Death invalidates every active task. Respawn starts with empty slots; nothing is replayed.
    }

    /** The body leaves the world: both slots settle in place (they are not ticked again); results are sent. */
    void finalizeActive(BotPlayer bot) {
        sync.finalizeInline();
        current.finalizeInline();
        holder = null;
        // As in tick(): settle state before announcing results, since a result synchronously starts a turn
        // that reads <current_task>.
        shipResults(bot);
    }

    /** Cancel a Runtime-owned task and deliver its terminal result without waiting for a game tick. */
    boolean cancelMatchingAtStablePoint(BotPlayer bot, String toolCallId) {
        boolean cancelled = false;
        TaskRecord syncRecord = sync.record();
        if (syncRecord != null && java.util.Objects.equals(syncRecord.getToolCallId(), toolCallId)) {
            sync.cancelAndSettle(bot);
            cancelled = true;
        }
        TaskRecord currentRecord = current.record();
        if (currentRecord != null && java.util.Objects.equals(currentRecord.getToolCallId(), toolCallId)) {
            current.cancelAndSettle(bot);
            cancelled = true;
        }
        if (cancelled) {
            holder = null;
            shipResults(bot);
        }
        return cancelled;
    }

    // ---- Slot proxies: let the selector query a slot as it would a Task ----

    private final Task syncProxy = new SlotProxy(() -> sync);
    private final Task currentProxy = new SlotProxy(() -> current);

    private Task slotTask(TaskSlot slot, BotPlayer bot) {
        if (slot.isEmpty()) {
            return null;
        }
        return slot == sync ? syncProxy : currentProxy;
    }

    /**
     * Wraps a slot as a {@link Task} for the selector.
     *
     * <p>The selector only knows "can it run" and should not know what a slot is, while a slot's tick also
     * settles and delivers results, so it is not a plain Task. This thin wrapper keeps both sides simple.
     */
    private static final class SlotProxy implements Task {
        private final java.util.function.Supplier<TaskSlot> slot;

        SlotProxy(java.util.function.Supplier<TaskSlot> slot) {
            this.slot = slot;
        }

        @Override public boolean canRun(BotPlayer bot) {
            return slot.get().canRun(bot);
        }

        @Override public TaskState tick(BotPlayer bot) {
            slot.get().tick(bot);
            return TaskState.RUNNING;
        }

        @Override public void stop(BotPlayer bot, StopReason why) {
            slot.get().loseBody(bot);
        }

        @Override public String name() {
            return "slot";
        }
    }

    /**
     * Delivers settled records. Only Runtime SDK calls have a receiver; other records are dropped.
     */
    private void shipResults(BotPlayer bot) {
        if (outbox.isEmpty()) {
            return;
        }
        while (!outbox.isEmpty()) {
            TaskRecord rec = outbox.pollFirst();
            if (rec.getToolCallId() != null
                    && rec.getToolCallId().startsWith(TaskRecord.RUNTIME_CALL_PREFIX)) {
                RuntimeTaskCompletions.complete(rec);
            }
        }
    }
}
