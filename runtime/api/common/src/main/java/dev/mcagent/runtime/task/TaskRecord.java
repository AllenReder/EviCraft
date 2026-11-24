package dev.mcagent.runtime.task;
import dev.mcagent.runtime.task.TaskResult;

import java.util.concurrent.atomic.AtomicLong;

/**
 * Mutable descriptor of an in-flight task. The {@link dev.mcagent.runtime.agent.tool.RuntimeTool tool layer}
 * builds one record per LLM {@code tool_call} and enqueues it;
 * {@code BotTickDispatcher} picks it up (running the matching
 * {@link Task}), drives lifecycle, and writes a
 * {@link TaskResult} back before completion.
 *
 * <h2>Type pattern</h2>
 * Concrete subclasses (e.g. {@code MoveToTaskRecord}) carry the typed input
 * parameters as final fields. {@link TaskFactory} dispatches the queue
 * head against the registered record types — no reflection at runtime, just one
 * {@code instanceof} check per record at the dispatch boundary.
 *
 * <h2>Threading</h2>
 * Records are constructed off-tick (in the LLM async callback) and read on
 * the server tick thread. The "construct off-tick" is followed by a hop
 * through {@code server.execute(...)} into the tick thread before the record
 * is enqueued, so the happens-before is established by the executor's queue —
 * no fields need to be {@code volatile}.
 *
 * <h2>Why not a record (Java {@code record} keyword)</h2>
 * State transitions ({@link TaskState}, {@link TaskResult}) need to be
 * mutable. Subclass-style {@code class} fits.
 */
public abstract class TaskRecord {

    private static final AtomicLong ID_SOURCE = new AtomicLong();

    /** Monotonically increasing internal id; only used for logging / dedup. */
    /**
     * The "deadline" of a standing task: a game tick that never arrives.
     *
     * <p>A deadline answers "how long should this take", and a standing task <b>never finishes</b>; a real
     * deadline would schedule a certain timeout. {@code MAX_VALUE/2} rather than {@code MAX_VALUE}: each
     * preempted tick adds one (see {@code TaskSlot.freeze}), and the headroom keeps it from overflowing
     * to a negative value.
     */
    public static final long NO_DEADLINE = Long.MAX_VALUE / 2;

    private final long id;
    /** Stable name of the originating tool (matches {@code RuntimeTool.name()}). */
    private final String toolName;
    /**
     * The {@code id} field from the LLM's {@code tool_call} — must be echoed
     * verbatim in the {@code tool_call_id} of the role:tool response, or the
     * upstream API responds 400.
     */
    private final String toolCallId;
    /**
     * Game-tick (level.getGameTime()) at which this record times out. Stamped
     * at construction (gameTime is freeze-aware, so {@code /tick freeze} /
     * {@code /tick rate} are accounted for automatically); a goal whose real
     * budget depends on world state only known at start may push it later via
     * {@link #extendDeadlineTo} (e.g. move_to scales with journey distance —
     * the tool layer can't know that, it has no entity position).
     */
    private long deadlineGameTime;

    private TaskState state = TaskState.PENDING;
    private TaskResult result;
    /** Dispatched asynchronously: the tool_call was answered on acceptance; completion uses task_finished. */
    private boolean async;
    /** Game tick of the first entry into RUNNING; task_status reports elapsed time. -1 = not started. */
    private long startedGameTime = -1;

    protected TaskRecord(String toolName, String toolCallId, long deadlineGameTime) {
        this.id = ID_SOURCE.incrementAndGet();
        this.toolName = toolName;
        this.toolCallId = toolCallId;
        this.deadlineGameTime = deadlineGameTime;
    }

    public final long getId() { return id; }
    public final String getToolName() { return toolName; }
    public final String getToolCallId() { return toolCallId; }
    public final long getDeadlineGameTime() { return deadlineGameTime; }
    public final TaskState getState() { return state; }
    public final TaskResult getResult() { return result; }

    /** Push the deadline later (never earlier). Tick-thread only, like all reads. */
    public final void extendDeadlineTo(long gameTime) {
        if (gameTime > deadlineGameTime) deadlineGameTime = gameTime;
    }

    /** Short LLM-visible task id, shared by the acceptance reply, current_task and the task_finished event. */
    public final String publicId() { return "t" + id; }

    public final void markAsync() { this.async = true; }
    public final boolean isAsync() { return async; }

    /**
     * Prefix of the synthetic tool-call ids the Runtime mints for external (MCP)
     * invocations — disjoint from the LLM's ids. The async wind-down keys off this
     * to route completion: internal tasks fire a task_finished event to the built-in
     * brain; external ones don't (their driver polls task_status instead).
     */
    public static final String EXTERNAL_CALL_PREFIX = "mcp-";
    public static final String RUNTIME_CALL_PREFIX = "runtime-";

    /** True if an external brain (MCP) dispatched this task, not the built-in LLM. */
    public final boolean isExternalCall() {
        return toolCallId != null && (toolCallId.startsWith(EXTERNAL_CALL_PREFIX)
                || toolCallId.startsWith(RUNTIME_CALL_PREFIX));
    }

    /** Stamp the first start (later calls do not overwrite it: resuming after preemption is not a restart). */
    public final void markStarted(long gameTime) {
        if (startedGameTime < 0) startedGameTime = gameTime;
    }
    public final long getStartedGameTime() { return startedGameTime; }

    /**
     * The tick it was accepted on has not passed yet.
     *
     * <p>Separates two kinds of "dispatch another job": the second one in the same batch of tool calls (the
     * model is planning; refuse it so the model sees the first result before deciding), and one from a new
     * turn (a change of mind; replace directly).
     *
     * <p><b>It asks how old the record is, not how many ticks the task ran.</b> Tasks go dormant: while
     * next to its target, {@code follow} does not use the body and the slot is not ticked, so its tick
     * count stays 0. With that as the criterion, a follow task running for ten minutes would still count
     * as just accepted, and every request to pick up a drop would be refused.
     */
    public final boolean acceptedThisTick(long gameTime) {
        return startedGameTime >= 0 && gameTime <= startedGameTime;
    }

    /** Called by {@code BotTickDispatcher} as the record transitions through lifecycle. */
    public final void setState(TaskState state) { this.state = state; }
    public final void setResult(TaskResult result) { this.result = result; }

    /**
     * Short human-readable description for the {@code debug} head
     * overlay. Defaults to the tool name; subclasses override to append their
     * salient parameters (e.g. {@code MoveToTaskRecord} adds the target coords).
     */
    public String describe() {
        return toolName;
    }
}
