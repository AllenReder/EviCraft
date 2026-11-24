/**
 * Server-side navigation for the Bot's body: planning, move generation and real execution for a fake
 * {@code ServerPlayer} in a modifiable world.
 *
 * <h2>Package layout</h2>
 * <ul>
 *   <li>{@code goals/} — engine goal family: single-cell, two-cell, neighborhood, column, layer, composite,
 *       run-away and others, each with its arrival semantics and heuristic.</li>
 *   <li>{@code moves/} — cost model and move primitives: action cost table, cost context
 *       ({@code CalculationContext}, which absorbs the sacred/deniedPlace semantic switches), predicate
 *       library ({@code MovementHelper}), tool evaluation ({@code ToolSet}), and the pricing plus per-tick
 *       state machine of the eight move primitive kinds.</li>
 *   <li>{@code astar/} — the search: binary-heap open set, coefficient-tiered partial-path candidates,
 *       favoring discount, path assembly (cutoff/splice/trim).</li>
 *   <li>{@code execute/} — execution layer: the public entry point {@code PlayerNav} with its three-state
 *       contract, the segment planning state machine ({@code PathingCore}), the per-move driver for one
 *       segment ({@code PathExecutor}), and input/view application
 *       ({@code ExecHarness}/{@code AimProcessor}).</li>
 *   <li>{@code bridge/} — server wiring: snapshot context factory, async search dispatch on the shared
 *       pool, mapping from the task-layer goal vocabulary to the engine goal family.</li>
 *   <li>{@code cache/} — loaded-chunk snapshot published every tick and the search-side world views
 *       (safe to read from worker threads).</li>
 *   <li>{@code calc/} — task-layer vocabulary and the shared worker pool: {@code NavGoal} (task-layer goal
 *       interface) and {@code PathPlannerPool}.</li>
 *   <li>{@code goal/} — intent contract layer: {@code GoalCompiler} compiles a task intent into a complete
 *       navigation contract of goal + sacred set.</li>
 *   <li>{@code settings/} — all tuning knobs ({@code NavSettings}).</li>
 *   <li>{@code util/} — block predicate library ({@code BlockHelper}) and the block-entity view interface
 *       that can be answered offline ({@code BlockEntityAware}).</li>
 * </ul>
 *
 * <p>Public contract (target state): the task layer uses this package only through
 * {@code execute.PlayerNav} + {@code goal.GoalCompiler} (plus the {@code calc.NavGoal} vocabulary for custom
 * goals); all other packages are internal and carry no stability promise. The task and tool layers still
 * reference some internal classes of moves/settings/bridge/cache/execute directly; new code must not add
 * more such references.
 */
package dev.mcagent.runtime.core.pathing;
