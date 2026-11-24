/**
 * Root of the body tools, split into packages by <b>domain</b> (perception: look, inventory: items,
 * interact: touch, locate: find, work: long jobs, agent: self-management). The package name answers "what
 * is this for"; the execution mechanism is not part of it, and each tool chooses its channel in its own
 * implementation. The root holds only registrars and shared helpers (*Ops implementations, ToolParse,
 * MenuOps). Registration is centralized in RuntimeCore and its order is the prompt cache key, so new
 * tools are always appended at the end of the registry.
 *
 * <h2>Four questions for a new tool (ask in order; the answers pick the execution channel)</h2>
 * <ol>
 *   <li><b>Does it need to touch the server's world (read or write)?</b><br>
 *       No → complete it in invoke, outside the task system.</li>
 *   <li><b>Does it only look, or does it act?</b><br>
 *       Looks only, but must read the world safely on the server thread → mechanically an enqueue short
 *       task (for example the two locate tools; the reason is in their class comments). Acts → next
 *       question.</li>
 *   <li><b>Is it guaranteed to finish within a few seconds in the worst case?</b><br>
 *       Test: can you give it a fixed deadline that never fails it unfairly? Yes ("equip times out after 5
 *       seconds" is reasonable) → TaskDispatch.enqueue, and the turn waits for the result. No ("mine 32
 *       iron, 5 second timeout" is absurd; the duration depends on the world) → TaskDispatch.dispatchAsync,
 *       with an acceptance receipt and a task_finished event at the end.</li>
 *   <li><b>Does it have a moment where it is done?</b><br>
 *       No (follow, guard: it only ever gets stopped) → it is not a tool call at all but a resident chain:
 *       register a TaskChain that takes part in bidding, and make the tool only a switch (the switch itself
 *       returns immediately).</li>
 * </ol>
 *
 * <h2>Cost of choosing wrong (why the questions matter)</h2>
 * <ul>
 *   <li>enqueue where dispatchAsync was needed: the serial dispatcher waits on a minutes-long job, the turn
 *       freezes, and the Bot appears to hang;</li>
 *   <li>dispatchAsync where enqueue was enough: pays the LLM cost and latency of an extra
 *       "accept → sleep → event wake-up" round for nothing;</li>
 *   <li>a task where a resident chain was needed: a task that never completes holds the lane forever, and
 *       the occupancy gate rejects everything after it;</li>
 *   <li>a pure query sent through the queue: while the body is busy with a long job, even "what is nearby"
 *       is rejected.</li>
 * </ul>
 */
package dev.mcagent.runtime.core.tools;
