/**
 * Bridge between the pathing engine and the rest of the runtime:
 * <ul>
 *   <li>{@link dev.mcagent.runtime.core.pathing.bridge.ContextFactory} —
 *       server chunk snapshots (cache/) → frozen {@code CalculationContext}; also provides the live context
 *       used during execution.</li>
 *   <li>{@link dev.mcagent.runtime.core.pathing.bridge.SearchDispatcher} /
 *       {@link dev.mcagent.runtime.core.pathing.bridge.PoolSearchDispatcher} —
 *       async search dispatch and polling handles on the shared worker pool.</li>
 *   <li>{@link dev.mcagent.runtime.core.pathing.bridge.GoalAdapter} —
 *       per-factory mapping and generic wrapping from the task-layer goal vocabulary ({@code NavGoal}
 *       factories) to the engine goal family ({@code goals.Goal}).</li>
 * </ul>
 */
package dev.mcagent.runtime.core.pathing.bridge;
