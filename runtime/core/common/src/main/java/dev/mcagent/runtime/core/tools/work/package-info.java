/**
 * Long jobs: goto, mining, building, blueprints, fishing, combat, pickup. Every task whose duration is
 * unbounded (it depends on the world) lives here and goes through dispatchAsync: acceptance returns a
 * task_id receipt, and completion wakes the agent through a task_finished event. The occupancy gate allows
 * one job at a time.
 *
 * <p>Review rule: no dispatchAsync outside this package, and no enqueue inside it.
 * Each tool has a matching TaskRecord + Task pair in the mirrored task/&lt;domain&gt; package.
 * See the {@link dev.mcagent.runtime.core.tools} package docs for the four questions.
 */
package dev.mcagent.runtime.core.tools.work;
