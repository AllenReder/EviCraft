package dev.mcagent.runtime.task;

import dev.mcagent.runtime.entity.BotPlayer;

/**
 * Something that wants to use the body. <b>Reflexes, synchronous actions, commands and standing behaviors
 * all share this one interface.</b>
 *
 * <h2>Why one interface suffices</h2>
 * Modeling their differences as differences of type (chain / task / mode / instinct) adds one mechanism
 * per kind. They actually differ in only two ways, and both are <b>behavior</b>, not <b>type</b>:
 *
 * <ul>
 *   <li>whether {@link #tick} returns a terminal state: <b>if it does, the task is bounded</b> (mine 64
 *       blocks, then yield); <b>if it always returns RUNNING, it is standing</b> (fish or follow until
 *       replaced). So the same fishing code serves both {@code fish(count=64)} and {@code fish()};</li>
 *   <li><b>who put it in</b>: the three verbs of {@link TaskDispatch} decide which layer it lands in.</li>
 * </ul>
 *
 * <h2>Three layers</h2>
 * Each tick {@link TaskSelector} asks from the top down "can you run?"; the first to say yes gets the body:
 *
 * <pre>
 * 1. Reflex        several, in registration order — waiting for the model is too late
 *                                                   (self-defense, self-rescue, fall breaking)
 * 2. Synchronous   0 or 1                         — the turn waits on it; short and bounded
 * 3. Current task  one slot                       — whatever was last requested; empty = the Bot stands
 * </pre>
 *
 * <p>No priority numbers, no bands, no chains. The layer order is all the ordering there is; within a
 * layer only reflexes need an order, and they use registration order.
 */
public interface Task {

    /**
     * Whether it can run now. A reflex uses it as its trigger (hungry, about to drown); a standing task uses
     * it for "cannot right now" (the followed player is too far, the fishing rod is gone). That is dormancy,
     * not failure: the task resumes by itself when the condition returns.
     *
     * <p>Defaults to {@code true}: dispatched work should run.
     */
    default boolean canRun(BotPlayer bot) {
        return true;
    }

    /**
     * The first tick with the body. Regaining the body after preemption does <b>not</b> call this again
     * (that is a resume, not a restart).
     *
     * <p>Does nothing by default: reflexes have no start, only a trigger.
     */
    default void start(BotPlayer bot) {
    }

    /** Advance one tick. {@link TaskState#RUNNING} = not done; terminal = done (a standing task never is). */
    TaskState tick(BotPlayer bot);

    /** Lose the body: preempted by a higher layer, replaced, or the body is gone. {@code why} says which. */
    void stop(BotPlayer bot, StopReason why);

    /**
     * The result envelope returned to the model. Meaningful only in a terminal state, so it is never called
     * for a standing task.
     *
     * <p>Every task must produce a result. Otherwise each layer would invent its own timeout fallback and the
     * same question would be answered separately in dozens of files.
     */
    default TaskResult result(TaskState terminal) {
        return null;
    }

    /** Short name for logs and panels. */
    String name();

    /** Why the body was lost. */
    enum StopReason {
        /** Preempted by a higher layer (a reflex or a synchronous action); state is kept for the resume. */
        PREEMPTED,
        /** Replaced: the request changed, or the model dispatched new work. */
        REPLACED,
        /** The body is gone: death, dismissal, or disconnect. */
        BODY_GONE
    }
}
