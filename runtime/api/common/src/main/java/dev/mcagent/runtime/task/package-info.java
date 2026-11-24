/**
 * The task machinery behind body tools.
 * <ul>
 *   <li>{@link TaskRecord} / {@link TaskState} / {@link TaskResult}: the typed envelope a world-action
 *       tool emits, its lifecycle states, and the result read back;</li>
 *   <li>{@link Task}: the executor a tool implements per record type;</li>
 *   <li>{@link TaskFactory} / {@link TaskDispatch} / {@link BotTickDispatcher}: registration and
 *       the points that drive tasks each server tick.</li>
 * </ul>
 *
 * <p>{@code BotBrain}, {@code TaskSlot} and {@code TaskSelector} are the scheduler's own
 * internals.
 */
package dev.mcagent.runtime.task;
