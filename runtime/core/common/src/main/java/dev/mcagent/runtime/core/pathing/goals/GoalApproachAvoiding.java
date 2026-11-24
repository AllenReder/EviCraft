package dev.mcagent.runtime.core.pathing.goals;

import dev.mcagent.runtime.core.pathing.goals.GoalAvoidEntities.Threat;

/**
 * Approach a target while <b>avoiding other threats on the way</b>.
 *
 * <h2>Why</h2>
 * A plain approach goal takes the shortest route, which often runs straight through a second mob: going for
 * one skeleton through three zombies leaves the Bot nearly dead on arrival. Positioning is part of combat and
 * should not wait until retreat is needed.
 *
 * <h2>The target itself is not a threat</h2>
 * The target is <b>also</b> hostile. If it were in the repulsion set it would push the Bot away, so the Bot
 * would never arrive while the estimate kept saying "approaching". The caller excludes it; this class only
 * combines the two parts it is given.
 *
 * <h2>Units of the two parts</h2>
 * Attraction is the <b>real walking cost</b> (same source as other goals); repulsion is the
 * {@link GoalAvoidEntities} potential field, scaled into the same unit by {@code penaltyFactor}. A larger
 * factor makes the Bot detour more; a smaller one lets it brush past mobs.
 */
public class GoalApproachAvoiding implements Goal {

    private final Goal approach;
    private final GoalAvoidEntities repulsion;

    /**
     * @param approach  where to go
     * @param repulsion what to avoid on the way, and what <b>must not be adjacent once standing</b>
     */
    public GoalApproachAvoiding(Goal approach, GoalAvoidEntities repulsion) {
        this.approach = approach;
        this.repulsion = repulsion;
    }

    /** Threats to avoid; the search reads this table to add the cost of entering them to edge costs. */
    public GoalAvoidEntities repulsion() {
        return repulsion;
    }

    /** Wraps only when there is something to avoid; otherwise returns {@code approach} unchanged. */
    public static Goal wrap(Goal approach, double penaltyFactor, Threat... threats) {
        if (threats.length == 0) {
            return approach;
        }
        return new GoalApproachAvoiding(approach, new GoalAvoidEntities(penaltyFactor, threats));
    }

    /**
     * Reached only when <b>both parts agree</b>: the Bot is at the target, and the cell is outside every
     * threat's danger radius.
     *
     * <p>If only {@code approach} were checked, avoidance would affect the <b>route</b> but not the
     * <b>standing cell</b>: entering the target's neighborhood would count as arrival even if three other
     * mobs surround that cell, and once arrived A* stops searching. Stance quality is part of membership,
     * not a heuristic preference.
     *
     * <p>This alone is not enough: the goal is a <b>snapshot taken when the path starts</b> and does not
     * invalidate itself when other mobs move. {@code PlayerNav}'s live-goal cadence re-takes the snapshot
     * periodically; both are required.
     */
    @Override
    public boolean isInGoal(int x, int y, int z) {
        return approach.isInGoal(x, y, z) && repulsion.isInGoal(x, y, z);
    }

    /**
     * <b>Pure distance</b>. Avoidance goes into <b>edge costs</b>, not the heuristic: a step into a mob's
     * danger
     * radius is itself expensive ({@code Avoidance.forGoal}).
     *
     * <h2>Why it cannot be added here</h2>
     * The heuristic must be a lower bound on remaining cost for A* to prune safely. Proximity to mobs <b>does
     * not decrease as the target gets closer</b> and grows when walking into a crowd. Adding it forces a
     * choice between strong enough to detour and weak enough not to break the search, and no factor achieves
     * both: a large one (800) fails to find even a two-block retreat ({@code NO-PATH}); a small one (15) does
     * not stop the Bot from walking through a large slime.
     *
     * <p>As an edge cost the conflict disappears: A* accumulates the cost per cell crossed, and the heuristic
     * stays admissible.
     */
    @Override
    public double heuristic(int x, int y, int z) {
        return approach.heuristic(x, y, z);
    }

    @Override
    public String toString() {
        return "GoalApproachAvoiding{" + approach + " avoiding " + repulsion + "}";
    }
}
