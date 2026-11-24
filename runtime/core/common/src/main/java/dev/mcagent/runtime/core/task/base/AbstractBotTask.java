package dev.mcagent.runtime.core.task.base;

import dev.mcagent.runtime.entity.InputDriver;

import dev.mcagent.runtime.core.pathing.execute.PlayerNav;
import dev.mcagent.runtime.task.Task;
import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.task.TaskRecord;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskResult;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The shared skeleton every reactive bot task grows on — the single place
 * the lifecycle ({@code start → tick* → buildResult}), the failure plumbing
 * ({@link FailureType} + a model-facing reason), the result envelope, and
 * yielding on pre-emption all live, so a concrete task only writes the
 * behaviour that is actually specific to it.
 *
 * <h2>Why a base class (the recovery boundary)</h2>
 * The reactive layer's governing rule is that a task is a <em>recovery
 * boundary</em>: it owns the execution of ONE bounded goal and everything that
 * happens inside it — retries, alternative approaches, sub-steps — recovers that
 * same goal without ever expanding its scope or auto-acquiring a prerequisite. A
 * prerequisite gap (no material, wrong tool, target lost) is not recovered here;
 * it is reported via {@link #fail(String, FailureType)} and kicked back to the
 * LLM. Concrete tasks implement the retries required by their bounded goal.
 *
 * <h2>Lifecycle (all {@code final}, so subclasses can't break the contract)</h2>
 * <ul>
 *   <li>{@link #start} runs the {@link #preconditions()} in order; the first
 *       that reports a {@link Precondition.Failure} terminates the task
 *       immediately (via {@link #fail}); otherwise {@link #onStart()} runs.</li>
 *   <li>{@link #tick} short-circuits to the terminal state a {@code fail(...)}
 *       (or a start-time precondition) parked in {@code pendingTerminal};
 *       otherwise it delegates to {@link #onTick()}.</li>
 *   <li>{@link #result(TaskState)} runs {@link #cleanup()} and then templates
 *       the {@link TaskResult} from the terminal state and the overridable
 *       message / data hooks.</li>
 * </ul>
 *
 * <h2>The onTick fail idiom</h2>
 * A concrete {@link #onTick()} reports a failure with
 * {@snippet : fail(reason, FailureType.SOMETHING); return TaskState.FAILED; }
 * — {@link #fail} records the reason + type (so {@link #buildResult} and any
 * caller can read them) and {@code return FAILED} ends the tick. The two
 * are kept separate (rather than {@code fail} returning {@code FAILED}) so a
 * caller can also stash a failure for the NEXT tick to observe.
 *
 * @param <R> the concrete {@link TaskRecord} subtype carrying this task's typed
 *            input fields.
 */
public abstract class AbstractBotTask<R extends TaskRecord>
        implements Task {

    /** The body this task drives. */
    protected final BotPlayer player;
    /** The typed input record for this task. */
    protected final R r;
    /** The active navigation, if any — owned here so {@link #stopNav()} / {@link #cleanup()} can release it. */
    protected PlayerNav nav;

    /** Model-facing reason for a terminal FAILED; also the fallback result message. */
    private String doneReason = "done";
    /** Structured cause of the last failure, for a caller to branch on. */
    private FailureType failType = FailureType.UNKNOWN;
    /**
     * A terminal state decided out-of-band (a start-time precondition, or a
     * {@link #fail} called from anywhere): {@link #tick} returns it verbatim
     * instead of running {@link #onTick()}.
     */
    private TaskState pendingTerminal;
    /** Sneak state the body had when this task took it; releasing the body returns to it. */
    private boolean sneakingAtStart;

    protected AbstractBotTask(BotPlayer player, R record) {
        this.player = player;
        this.r = record;
    }

    // ---------------------------------------------------------------------
    // Lifecycle (final — the frozen contract)
    // ---------------------------------------------------------------------

    @Override
    public final void start(BotPlayer bot) {
        sneakingAtStart = player.isShiftKeyDown();
        for (Precondition p : preconditions()) {
            Precondition.Failure f = p.check();
            if (f != null) {
                fail(f.message(), f.type());
                r.setState(TaskState.FAILED);   // same-tick finalization (old dispatcher semantics)
                return;
            }
        }
        try {
            onStart();
        } catch (RuntimeException e) {
            crashed("start", e);
            r.setState(TaskState.FAILED);
            return;
        }
        // A terminal parked DURING start (a fail(...) or succeed() from onStart — the
        // one-shot tasks do their whole job there) is stamped on the record NOW, so
        // the dispatcher finalizes it in the same tick it started. Without this, the
        // record sits RUNNING for one tick with the work already done, and an owner
        // Stop in that window would ship "interrupted" for work that actually
        // happened — diverging the model's world-view from the inventory.
        if (pendingTerminal != null) {
            r.setState(pendingTerminal);
        }
    }

    @Override
    public final TaskState tick(BotPlayer bot) {
        if (pendingTerminal != null) return pendingTerminal;
        // Ticks spent waiting while the planner is in flight and the body has no segment to walk do not burn
        // the task budget: the deadline measures ticks of body work, and the wall-clock latency of an async
        // search is not the task's fault (same principle as freezeTick when the scheduler is pre-empted by a
        // survival chain). At the normal tick rate a search takes only a few ticks, so this barely moves;
        // when ticks run much faster than real time (e.g. an unthrottled test server), without this freeze
        // the task would hit TIMEOUT before the first search returns.
        if (nav != null && nav.planningInFlight()) {
            r.extendDeadlineTo(r.getDeadlineGameTime() + 1);
        }
        try {
            return onTick();
        } catch (RuntimeException e) {
            crashed("tick", e);
            return TaskState.FAILED;
        }
    }

    /**
     * Handling for a task that throws: <b>this one task fails instead of crashing the whole server</b>.
     *
     * <p>Tasks run every tick in the server main loop, and the layer above is
     * {@code record.setState(task.tick())}, with no protection. What tasks do is inherently unpredictable:
     * building calls vanilla callbacks on up to eight <b>arbitrary</b> blocks per tick, the miner touches
     * arbitrary block entities, and blueprints come from freely editable files in the player's directory. Any
     * exception escaping would become a "Ticking entity" server crash, costing the player the whole session,
     * all because of a single block.
     *
     * <p>So it is caught once at the framework layer, not separately in each task: a failed task can be
     * explained (the model receives the reason, the player sees what was already built); a crash cannot. The
     * exception is logged with the task name, since swallowing the symptom without evidence is harder to
     * debug than a crash.
     */
    private void crashed(String phase, RuntimeException e) {
        dev.mcagent.runtime.core.Constants.LOG.error(
                "[mc_agent-task] {} threw an exception in the {} phase; task marked failed (server unaffected)",
                getClass().getSimpleName(), phase, e);
        fail("the task hit an internal error and stopped: " + e.getClass().getSimpleName()
                + (e.getMessage() == null ? "" : " — " + e.getMessage())
                + ". Anything already built stays; this is a bug worth reporting.",
                FailureType.INTERNAL);
    }

    @Override
    public final TaskResult result(TaskState finalState) {
        try {
            cleanup();
        } catch (RuntimeException exception) {
            dev.mcagent.runtime.core.Constants.LOG.error("Task cleanup failed: {}", getClass().getSimpleName(), exception);
            // Release the base-owned navigation even if a subclass failed before reaching it.
            try {
                stopNav();
            } catch (RuntimeException navFailure) {
                dev.mcagent.runtime.core.Constants.LOG.error("Task navigation release failed: {}",
                        getClass().getSimpleName(), navFailure);
            } finally {
                if (player != null) {
                    InputDriver.halt(player);
                    player.setShiftKeyDown(sneakingAtStart);
                }
            }
        }
        // Keep the physical outcome separate from resource cleanup diagnostics.
        Map<String, Object> data = new HashMap<>(resultData());
        return switch (finalState) {
            case SUCCESS   -> TaskResult.ok(successMessage(), data);
            case TIMEOUT   -> new TaskResult(false, timeoutMessage(), true, false, data);
            case CANCELLED -> new TaskResult(false, cancelledMessage(), false, true, data);
            // FAILED and any stray state
            default        -> new TaskResult(false, doneReason, false, false, failType.wireValue(), data);
        };
    }

    // ---------------------------------------------------------------------
    // Hooks (override the ones a concrete task needs)
    // ---------------------------------------------------------------------

    /** Ordered start-time gates; the first {@link Precondition.Failure} wins. Default: none. */
    protected List<Precondition> preconditions() {
        return List.of();
    }

    /** First-tick setup (build the nav, snapshot baselines, …). Default: no-op. */
    protected void onStart() {}

    /** Advance one tick; return {@link TaskState#RUNNING} or a terminal state. */
    protected abstract TaskState onTick();

    /** Release physical resources on termination. Default: stop nav + clear the path overlay. */
    protected void cleanup() {
        stopNav();
    }

    /** Structured payload for the result envelope. Default: a fresh empty (mutable) map. */
    protected Map<String, Object> resultData() {
        return new HashMap<>();
    }

    /** Message for a SUCCESS result. */
    protected abstract String successMessage();

    /** Message for a TIMEOUT result. Default: {@code "timed out"}. */
    protected String timeoutMessage() {
        return "timed out";
    }

    /** Message for a CANCELLED result. Default: {@code "interrupted"}. */
    protected String cancelledMessage() {
        return "interrupted";
    }

    // ---------------------------------------------------------------------
    // Failure plumbing
    // ---------------------------------------------------------------------

    /**
     * Record a failure: stash the model-facing reason and structured cause, and
     * park a terminal FAILED for {@link #tick} to surface. Callers in
     * {@link #onTick()} pair this with {@code return TaskState.FAILED;}.
     */
    protected void fail(String why, FailureType t) {
        // Terminal outcomes must be logged: why a task ended is the first thing to check when debugging, so it
        // cannot live only in the return value
        dev.mcagent.runtime.core.Constants.LOG.info("[mc_agent-task] {} FAILED({}) {}",
                getClass().getSimpleName(), t, why);
        this.doneReason = why;
        this.failType = t;
        this.pendingTerminal = TaskState.FAILED;
    }

    /**
     * Park a terminal SUCCESS — the mirror of {@link #fail} for one-shot tasks whose
     * whole job happens in {@link #onStart()} (drop, equip): {@link #tick} surfaces
     * it, and {@link #start} stamps it on the record for same-tick finalization.
     */
    protected void succeed() {
        this.pendingTerminal = TaskState.SUCCESS;
    }

    /** The structured cause of the most recent failure (or {@link FailureType#UNKNOWN}). */
    protected FailureType lastFailure() {
        return failType;
    }

    /** The model-facing reason recorded by the most recent {@link #fail}. */
    protected String doneReason() {
        return doneReason;
    }

    // ---------------------------------------------------------------------
    // Nav ownership
    // ---------------------------------------------------------------------

    /** Stop and forget the active nav (idempotent). */
    protected void stopNav() {
        if (nav != null) {
            PlayerNav owned = nav;
            nav = null;
            owned.stop();
        }
    }

    // ---------------------------------------------------------------------
    // Suspendable (scheduler preemption)
    // ---------------------------------------------------------------------

    /**
     * Preempted by a higher-priority survival chain: release the BODY (zero the
     * locomotion inputs, return sneak to its state at start) but keep every logical field — including the
     * nav PLAN — intact. Deliberately does NOT call {@code nav.stop()}: the plan
     * is what lets {@link #resume()} pick straight back up on the next tick.
     */
    @Override
    public void stop(BotPlayer bot, StopReason why) {
        // Pre-empted: only release the body (zero the movement input, restore sneaking to its state at task
        // start); <b>leave every logic field untouched</b>, especially the path plan, which is what lets the
        // task resume when it gets the body back. Do not call nav.stop().
        // Replaced or body gone needs no extra cleanup: cleanup() in buildResult runs.
        InputDriver.halt(player);
        player.setShiftKeyDown(sneakingAtStart);
    }

    @Override
    public String name() {
        return getClass().getSimpleName();
    }
}
