package dev.mcagent.runtime.core.pathing.bridge;

import java.util.ArrayList;
import java.util.List;

import dev.mcagent.runtime.core.pathing.calc.NavGoal;
import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.goals.GoalBlock;
import dev.mcagent.runtime.core.pathing.goals.GoalApproachAvoiding;
import dev.mcagent.runtime.core.pathing.goals.GoalComposite;
import dev.mcagent.runtime.core.pathing.goals.GoalGetToBlock;
import dev.mcagent.runtime.core.pathing.goals.GoalNear;
import dev.mcagent.runtime.core.pathing.goals.GoalRing;
import dev.mcagent.runtime.core.pathing.goals.GoalRunAway;
import dev.mcagent.runtime.core.pathing.goals.GoalTwoBlocks;
import dev.mcagent.runtime.core.pathing.goals.GoalXZ;
import dev.mcagent.runtime.core.pathing.goals.GoalYLevel;

import net.minecraft.core.BlockPos;

/**
 * Maps the task-layer goal vocabulary ({@link NavGoal} factory products) to the engine goal family
 * ({@link Goal}). Factory products are recognized by their named type and mapped directly to native engine
 * goals; anonymous {@link NavGoal}s written in the task layer go through the generic {@link #wrap}
 * (isInGoal=isAt, heuristic passed through).
 *
 * <p>Mapping (per factory):
 * <ul>
 *   <li>exact → {@link GoalBlock}</li>
 *   <li>column(x,z) → {@link GoalXZ}</li>
 *   <li>yLevel → {@link GoalYLevel}</li>
 *   <li>near → {@link GoalNear} (subclass that keeps the squared radius as a double for precision)</li>
 *   <li>ring → {@link GoalRing} (standing band: the estimate is the distance to the band, with a gradient on
 *       both sides)</li>
 *   <li>nearGround → {@link GoalNear} subclass (keeps the horizontal radius plus a y±1 band instead of
 *       degenerating to a 3D sphere, so pillaring up next to the target in mid-air does not count as
 *       arrival)</li>
 *   <li>adjacent → {@link GoalGetToBlock} (different member set: same-level orthogonal neighbors are kept,
 *       the target cell itself and the two cells below are added, and y+1 neighbors are no longer members;
 *       body-level arrival is still checked by each task's own reached predicate)</li>
 *   <li>getToBlock → {@link GoalGetToBlock} (same membership cell by cell; the heuristic differs in shape:
 *       the NavGoal version subtracts a "one step + one jump" slack, the engine estimates from a corrected
 *       y difference)</li>
 *   <li>composite → {@link GoalComposite} (members mapped recursively)</li>
 *   <li>mineColumn → GoalTwoBlocks family: maxBelow=0 → {@link GoalBlock}, =1 → {@link GoalTwoBlocks},
 *       ≥2 → {@link GoalComposite} (two-cell goal plus one {@link GoalBlock} per extra cell); member set and
 *       standing band match cell by cell</li>
 *   <li>runAway → {@link GoalRunAway} (never arrives, expressed with {@link #NEVER_ARRIVE_DISTANCE}. The
 *       only caller is branch mining, which wants to keep digging outward; combat retreat uses
 *       {@code avoid}, which has an end point)</li>
 *   <li>avoid → the {@code GoalAvoidEntities} instance held by the facade (not rebuilt, so there is only
 *       one potential-field formula)</li>
 *   <li>approachAvoiding → {@link GoalApproachAvoiding} (attraction term mapped recursively, potential field
 *       reused as is)</li>
 * </ul>
 */
public final class GoalAdapter {

    private GoalAdapter() {}

    /**
     * NavGoal runAway means "never arrive, just keep moving away"; {@link GoalRunAway} needs an arrival
     * distance, so this is the largest value whose int square does not overflow (about 46340 blocks). A single
     * navigation segment can never cover that distance, so it is effectively never reached.
     */
    static final double NEVER_ARRIVE_DISTANCE = 46_340;

    /** Maps or wraps a task-layer goal into an engine goal. */
    public static Goal toEngineGoal(NavGoal goal) {
        if (goal instanceof NavGoal.ApproachAvoiding g) {
            return new GoalApproachAvoiding(toEngineGoal(g.approach), g.repulsion);
        }
        if (goal instanceof NavGoal.Avoid g) {
            return g.engine;   // the facade already holds the engine goal; hand it over
        }
        if (goal instanceof NavGoal.Exact g) {
            return new GoalBlock(g.goal);
        }
        if (goal instanceof NavGoal.Column g) {
            return new GoalXZ(g.x, g.z);
        }
        if (goal instanceof NavGoal.YLevel g) {
            return new GoalYLevel(g.level);
        }
        if (goal instanceof NavGoal.Ring g) {
            return new GoalRing(g.goal, g.inner, g.outer);
        }
        if (goal instanceof NavGoal.Near g) {
            return new RadiusNear(g.goal, g.radiusSqr, false);
        }
        if (goal instanceof NavGoal.NearGround g) {
            return new RadiusNear(g.goal, g.radiusSqr, true);
        }
        if (goal instanceof NavGoal.Adjacent g) {
            return new GoalGetToBlock(g.goal);
        }
        if (goal instanceof NavGoal.GetToBlock g) {
            return new GoalGetToBlock(g.goal);
        }
        if (goal instanceof NavGoal.Composite g) {
            Goal[] members = new Goal[g.members.size()];
            for (int i = 0; i < members.length; i++) {
                members[i] = toEngineGoal(g.members.get(i));
            }
            return new GoalComposite(members);
        }
        if (goal instanceof NavGoal.MineColumn g) {
            return mineColumnGoal(g.ore, g.maxBelow);
        }
        if (goal instanceof NavGoal.RunAway g) {
            return new GoalRunAway(NEVER_ARRIVE_DISTANCE, g.maintainY, g.from);
        }
        return wrap(goal);
    }

    /**
     * Ore-column standing band → GoalTwoBlocks family: the member set matches
     * {@code NavGoal.mineColumn(ore, maxBelow)} cell by cell (feet in {@code ore.y .. ore.y - maxBelow}).
     */
    private static Goal mineColumnGoal(BlockPos ore, int maxBelow) {
        if (maxBelow <= 0) {
            return new GoalBlock(ore);
        }
        if (maxBelow == 1) {
            return new GoalTwoBlocks(ore);
        }
        List<Goal> members = new ArrayList<>(maxBelow);
        members.add(new GoalTwoBlocks(ore));
        for (int below = 2; below <= maxBelow; below++) {
            members.add(new GoalBlock(ore.getX(), ore.getY() - below, ore.getZ()));
        }
        return new GoalComposite(members.toArray(Goal[]::new));
    }

    /**
     * Generic wrapper for anonymous/custom {@link NavGoal}s: membership and heuristic are passed through point
     * by point. Each query creates a new {@link BlockPos} (the NavGoal contract forbids implementations from
     * keeping a reference to the argument, and a throwaway object satisfies that trivially).
     */
    public static Goal wrap(NavGoal goal) {
        return new WrappedNavGoal(goal);
    }

    /** Product of {@link #wrap} (a named class for readable debug output). */
    static final class WrappedNavGoal implements Goal {

        final NavGoal delegate;

        WrappedNavGoal(NavGoal delegate) {
            this.delegate = delegate;
        }

        @Override
        public boolean isInGoal(int x, int y, int z) {
            return delegate.isAt(new BlockPos(x, y, z));
        }

        @Override
        public double heuristic(int x, int y, int z) {
            return delegate.heuristic(new BlockPos(x, y, z));
        }

        @Override
        public boolean ordersEqualCostGoals() {
            return delegate.ordersEqualCostGoals();
        }

        @Override
        public int compareEqualCostGoals(BlockPos left, BlockPos right) {
            return delegate.compareEqualCostGoals(left, right);
        }

        @Override
        public String toString() {
            return "WrappedNavGoal{" + delegate + "}";
        }
    }

    /**
     * Neighborhood goal whose squared radius is stored as a double. With {@code groundBand} true, membership is
     * "squared horizontal distance ≤ squared radius and y difference within ±1" (nearGround semantics); with
     * false it is a 3D sphere whose squared radius is not rounded (fractional near radii are kept). The
     * heuristic is inherited (full estimate to the center, radius not subtracted).
     */
    static final class RadiusNear extends GoalNear {

        private final double radiusSqrExact;
        private final boolean groundBand;

        RadiusNear(BlockPos center, double radiusSqr, boolean groundBand) {
            super(center, (int) Math.ceil(Math.sqrt(radiusSqr)));
            this.radiusSqrExact = radiusSqr;
            this.groundBand = groundBand;
        }

        @Override
        public boolean isInGoal(int x, int y, int z) {
            int xDiff = x - this.x;
            int yDiff = y - this.y;
            int zDiff = z - this.z;
            if (groundBand) {
                if (yDiff < -1 || yDiff > 1) {
                    return false;
                }
                return xDiff * xDiff + zDiff * zDiff <= radiusSqrExact;
            }
            return xDiff * xDiff + yDiff * yDiff + zDiff * zDiff <= radiusSqrExact;
        }

        @Override
        public String toString() {
            return String.format("RadiusNear{x=%d,y=%d,z=%d,radiusSqr=%s,groundBand=%s}",
                    x, y, z, radiusSqrExact, groundBand);
        }
    }
}
