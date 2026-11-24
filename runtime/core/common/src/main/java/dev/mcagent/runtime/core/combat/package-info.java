/**
 * Combat system: <b>a top level decides the situation; the execution layer has two legs</b>.
 *
 * <h2>Top level: {@link dev.mcagent.runtime.core.combat.AttackPlan}</h2>
 * A pure function rerun from scratch every tick. It answers only two questions:
 *
 * <ul>
 *   <li><b>Can the fight still be won?</b> If effective health cannot hold, or no weapon is in hand → flee</li>
 *   <li><b>Bow or footwork?</b> If the target cannot be reached on foot, use the bow; otherwise use footwork</li>
 * </ul>
 *
 * <p>It <b>has no state flags</b>. Fleeing is not a mode that must be entered and exited: once health
 * recovers, the next tick returns to the fight with no exit condition to wait for. The only memory is the
 * previous tick's decision, used solely for target commitment (finish the chosen target before switching;
 * otherwise, in a group of splitting mobs, "the nearest one" changes every tick).
 *
 * <h2>Execution layer: two orthogonal legs</h2>
 * <table>
 *   <tr><th></th><th>Handles</th><th>Does not handle</th></tr>
 *   <tr><td>Attack</td><td>cooldown ready and someone within attack range → strike</td>
 *       <td>whether the Bot is closing in or backing off this tick</td></tr>
 *   <tr><td>Pathing</td><td>takes the Bot to where it can hit without being hit</td>
 *       <td>whether to strike</td></tr>
 * </table>
 *
 * <p>They run side by side without interfering; at most, attacking turns the Bot's head. If attacking
 * were an <b>action</b> exclusive with movement, neither the approach nor the retreat would swing: the Bot
 * would not hit back while evading, and could not catch a skeleton that backs off while shooting.
 *
 * <h2>Footwork is a ring, not two states</h2>
 * <pre>
 * inner edge = it can reach me   (Menace.rawDangerRadius, derived from hitboxes)
 * outer edge = I can reach it    (Swing.reachTo, vanilla ENTITY_INTERACTION_RANGE + target half-width)
 * inside the band, do nothing; the attack layer strikes on its own
 * </pre>
 *
 * It is written as one goal rather than "too close → back-off state, too far → approach state" because two
 * states easily make <b>the trigger line and the stop line the same line</b>, which oscillates at the
 * boundary. The band has built-in margin, so no hysteresis is needed.
 *
 * <h2>Where the numbers come from</h2>
 * Danger radius, reach distance, blast radius, fuse time, and attack interval are <b>all derived from vanilla
 * constants and hitboxes</b>, so they follow automatically for modded mobs and different body sizes. Only
 * preference values are hand-tuned: potential-field strength, edge-cost multipliers, and health thresholds.
 *
 * <h2>Classes</h2>
 * <ul>
 *   <li>{@link dev.mcagent.runtime.core.combat.AttackPlan}: the top-level decision</li>
 *   <li>{@link dev.mcagent.runtime.core.combat.Battlefield}: the situation fed to the decision for one tick</li>
 *   <li>{@link dev.mcagent.runtime.core.combat.Menace}: danger radius, i.e. how close is dangerous, defined in one place</li>
 *   <li>{@link dev.mcagent.runtime.core.combat.Swing}: how far the reach is and whether a swing may go out now</li>
 *   <li>{@link dev.mcagent.runtime.core.combat.Loadout}: which weapons are available</li>
 *   <li>{@link dev.mcagent.runtime.core.combat.WeaponDamage}: which weapon hits harder</li>
 * </ul>
 *
 * {@code core.task.combat.AttackTask} ties these together: every tick it scans the situation, asks the
 * decision once, runs the attack layer once, and drives the pathing layer once.
 */
package dev.mcagent.runtime.core.combat;
