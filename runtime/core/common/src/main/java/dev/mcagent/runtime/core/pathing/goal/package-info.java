/**
 * The intent boundary of the pathing package: tasks say WHAT they want
 * ({@link dev.mcagent.runtime.core.pathing.goal.GoalCompiler#interact interact
 * with this block}, {@link dev.mcagent.runtime.core.pathing.goal.GoalCompiler#standOn
 * stand on this cell}, {@link dev.mcagent.runtime.core.pathing.goal.GoalCompiler#mineField
 * mine this field}) and the compiler translates that — in ONE place — into the
 * things a navigation and its task must agree on: the search goal
 * (a {@link dev.mcagent.runtime.core.pathing.calc.NavGoal}) and the sacred cells the
 * route may neither break nor bury (threaded into
 * {@link dev.mcagent.runtime.core.pathing.moves.CalculationContext#sacred}).
 *
 * <p>Tasks should not hand-pick their NavGoal: a Euclidean sphere for "go to a
 * block" admits elevated cells, so approaches can finish by pillaring beside
 * their target, and it marks nothing untouchable, so routes can break or bury
 * the very block they are travelling to.
 *
 * <p>Package contract: pathing's public front door is
 * {@code PlayerNav} + {@code GoalCompiler} (+ the {@code NavGoal} vocabulary
 * for custom goals like {@code runAway}). Task code should not assemble
 * goal/sacred pairs by hand.
 */
package dev.mcagent.runtime.core.pathing.goal;
