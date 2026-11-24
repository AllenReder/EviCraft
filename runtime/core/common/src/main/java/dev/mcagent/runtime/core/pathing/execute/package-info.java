/**
 * Path execution layer: turns a computed path into real entity actions.
 *
 * <p>Three layers:
 * <ul>
 *   <li>{@link dev.mcagent.runtime.core.pathing.execute.PathingCore} — segment-planning
 *       state machine: goal → first-segment search → execute → plan ahead → seamless
 *       handoff; searches are dispatched through
 *       {@link dev.mcagent.runtime.core.pathing.bridge.SearchDispatcher};</li>
 *   <li>{@link dev.mcagent.runtime.core.pathing.execute.PathExecutor} — drives a single
 *       path movement by movement: relocation, off-path watchdog, cost verification,
 *       overall sprint decision, timeouts;</li>
 *   <li>{@link dev.mcagent.runtime.core.pathing.execute.ExecHarness} — input/view
 *       application: the view steps in quantized mouse pixels
 *       ({@link dev.mcagent.runtime.core.pathing.execute.AimProcessor}), the key table
 *       maps to entity input fields, and left/right clicks use the native server entry points.</li>
 * </ul>
 */
package dev.mcagent.runtime.core.pathing.execute;
