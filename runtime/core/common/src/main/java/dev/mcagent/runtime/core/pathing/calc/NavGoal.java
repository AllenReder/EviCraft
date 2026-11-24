package dev.mcagent.runtime.core.pathing.calc;

import dev.mcagent.runtime.core.pathing.goals.GoalAvoidEntities;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;
import dev.mcagent.runtime.core.pathing.moves.ActionCosts;
import net.minecraft.core.BlockPos;

import java.util.List;

/**
 * What the search is trying to reach. A goal object makes the search
 * terminate, the heuristic aim and the caller assert against the SAME
 * definition of arrival, instead of each call site keeping its own tolerance,
 * radius or "stand next to X" picker.
 *
 * <p>Node-domain only: {@link #isAt} judges feet CELLS during the search.
 * Live-entity arrival predicates (exact doubles, reach distances) remain the
 * task layer's business — they answer a different question ("is my body close
 * enough") than the search's ("may this node end the path").
 *
 * <p>Factory products are named nested classes (parameters exposed as final
 * fields): the bridge layer recognizes them by type and maps them directly to
 * the engine goal family; anonymous implementations (custom goals written in
 * the task layer) cannot be recognized and go through the generic wrapper.
 */
public interface NavGoal {

    // ---- heuristic constants (values come from the engine cost table) ----

    /** Horizontal distance factor of a diagonal step. */
    double SQRT_2 = Math.sqrt(2.0);
    /** Optimistic per-block cost used by weighted A* (about one sprinted block). */
    double COST_HEURISTIC = 3.563;
    /** Optimistic cost of rising one block (jump arc difference). */
    double JUMP_ONE_BLOCK = ActionCosts.JUMP_ONE_BLOCK_COST;
    /** Optimistic cost of dropping one block (half the time of a two-block fall). */
    double DESCEND_ONE_BLOCK = ActionCosts.FALL_N_BLOCKS_COST[2] / 2.0;
    /** Stable coordinate order used when navigation costs tie. */
    java.util.Comparator<BlockPos> STABLE_COORDINATE_ORDER = java.util.Comparator
            .comparingInt((BlockPos position) -> position.getX())
            .thenComparingInt(position -> position.getY())
            .thenComparingInt(position -> position.getZ());

    /** May a path legitimately end at this feet cell? */
    boolean isAt(BlockPos feet);

    /** Admissible lower bound (ticks) on the remaining cost from {@code from}. */
    double heuristic(BlockPos from);

    /** Representative position — diagnostics, goal-moved checks, locate math. */
    BlockPos center();

    /** Whether equal-cost terminal cells require goal-defined deterministic ordering. */
    default boolean ordersEqualCostGoals() {
        return false;
    }

    /** Compare two equal-cost terminal cells when {@link #ordersEqualCostGoals()} is true. */
    default int compareEqualCostGoals(BlockPos left, BlockPos right) {
        return 0;
    }

    // ---- the shared octile + vertical point bound ----

    /**
     * Octile horizontal distance (× walk cost) plus a vertical term — the
     * admissible point-to-point bound every concrete goal builds on. Downward
     * must cost &gt; 0 (see {@link #DESCEND_ONE_BLOCK}): with a free
     * down-direction every node straight above a deep target would score h == 0
     * and partial paths would collapse to the start node.
     *
     * <p>Known weight inconsistency (deliberate): the weighted-A* factor
     * {@code COST_HEURISTIC} (3.563) is folded into the XZ term only, while the
     * vertical terms ({@code JUMP_ONE_BLOCK} / {@code DESCEND_ONE_BLOCK}) are
     * unweighted. Search behaviour is tuned on this split; do not normalize the
     * weights in passing.
     *
     * <p>Adapter contract: {@code heuristic()} / {@code isAt()} implementations
     * must not retain the {@code BlockPos} argument (adapters may reuse a
     * mutable cursor across calls); read x/y/z (or compare/measure) and return.
     */
    static double pointBound(BlockPos goal, BlockPos from) {
        double dx = Math.abs(goal.getX() - from.getX());
        double dz = Math.abs(goal.getZ() - from.getZ());
        // Horizontal: (diagonal·√2 + straight) × COST_HEURISTIC. COST_HEURISTIC
        // (≈ sprint cost) IS the per-block weight here — the heap key adds no
        // further multiplier (the weight is folded into the heuristic itself).
        double horizontal = (Math.min(dx, dz) * SQRT_2 + Math.abs(dx - dz))
                * COST_HEURISTIC;
        // Vertical: up costs JUMP per block, down costs DESCEND (fall[2]/2).
        int dy = goal.getY() - from.getY();
        double vertical = dy > 0
                ? dy * JUMP_ONE_BLOCK
                : -dy * DESCEND_ONE_BLOCK;
        return horizontal + vertical;
    }

    // ---- factories ----

    /** Exactly this feet cell. */
    static NavGoal exact(BlockPos pos) {
        return new Exact(pos);
    }

    /**
     * Reach the {@code (x, z)} column at ANY height.
     * The heuristic is the pure horizontal
     * octile term (no vertical), so the search heads for the column and stops at
     * whatever ground exists there. This is the "go to a location" goal: the
     * caller's Y is irrelevant, so a wrong/guessed Y can never make it unreachable.
     */
    static NavGoal column(int x, int z) {
        return new Column(x, z);
    }

    /**
     * Reach a Y level at ANY X/Z: "change elevation to this height" (climb to the surface,
     * descend to a mining depth). Heuristic is the pure vertical term — up costs
     * {@link #JUMP_ONE_BLOCK} per block, down {@link #DESCEND_ONE_BLOCK}.
     */
    static NavGoal yLevel(int level) {
        return new YLevel(level);
    }

    /**
     * "How far from the goal" — the measure used only for <b>stuck detection</b>; defaults to the heuristic.
     *
     * <p>The heuristic may include other terms (such as a danger field) that swing widely while the Bot stands
     * still, as mobs move in and out around it. Used as progress, that noise reads as "moving forward" and
     * being stuck is never detected. Progress should answer one question only: is the Bot closer to where it
     * is going?
     */
    default double progressHeuristic(BlockPos from) {
        return heuristic(from);
    }

    /**
     * Ring stance: a distance from {@code pos} within {@code [inner, outer]}.
     *
     * <p>It provides not just an arrival condition but an <b>estimate</b>: the distance to the <b>band</b>,
     * decreasing toward the band from both sides. With a spherical neighborhood the estimate only says
     * "closer to the center is better", while every valid bow position is far away; the search then digs
     * toward the mob and {@code bestSoFar} picks the cell right next to it.
     */
    static NavGoal ring(BlockPos pos, double inner, double outer) {
        return new Ring(pos, inner, outer);
    }

    /** Any feet cell within {@code radius} (Euclidean, blocks) of {@code pos}. */
    static NavGoal near(BlockPos pos, double radius) {
        return new Near(pos, radius);
    }

    /**
     * Any feet cell within {@code radius} (Euclidean, blocks) of {@code pos}
     * HORIZONTALLY, with the feet at the target's height ±1. This is the
     * vicinity goal for chasing/following things that live on the ground: unlike
     * the raw 3D {@link #near} sphere it admits no elevated cell, so "place a
     * scaffold, stand on it, count as arrived" is not a satisfying completion —
     * the geometry that lets an approach finish by pillaring beside its
     * target.
     */
    static NavGoal nearGround(BlockPos pos, double radius) {
        return new NearGround(pos, radius);
    }

    /**
     * Any feet cell horizontally adjacent to {@code target} (±1 step on one
     * axis), at the target's height ±1 — "stand next to this block so you can
     * work on it". The standability of the ending cell is the graph's own
     * guarantee (only occupiable cells become nodes).
     */
    static NavGoal adjacent(BlockPos target) {
        return new Adjacent(target);
    }

    /**
     * Any feet cell TOUCHING {@code target}: beside it, on top of it, up to two
     * below it (the two-block body still reaches its underside) — or in it, if
     * the cell is enterable. Membership is a Manhattan bound with the body-height
     * correction: {@code |dx| + |dy'| + |dz| <= 1} where {@code dy' = dy < 0 ?
     * dy+1 : dy}. This is the "get to this block to use it" goal — the target
     * cell itself stays untouched (a chest, a crafting table), the path ends on
     * whichever neighbouring cell the graph can actually stand on.
     */
    static NavGoal getToBlock(BlockPos target) {
        return new GetToBlock(target);
    }

    /**
     * Stance for mining it: <b>the body touches it but does not stand on top of it</b>.
     *
     * <p>Touching means it is a neighbor of the feet cell or the head cell, so <b>by definition nothing lies
     * between</b> and it is reachable without a raycast. This is a lower-bound approximation of the mining
     * side's "the eyes have an unobstructed ray" check; a raycast is too expensive for {@code isAt}, which
     * runs once per expanded node.
     *
     * <p><b>Standing on top of it must be excluded</b>: the cell under the feet is the Bot's own floor, which
     * the mining layer never breaks (the rule for when the objective cell is also its own support). Including
     * it causes an endless loop: navigation reports "in position", mining reports "this cell cannot be
     * mined", navigation is torn down and replanned, and the Bot is still standing on the same cell.
     */
    static NavGoal mineStance(BlockPos ore) {
        return new MineStance(ore);
    }

    /**
     * Any of several goals. Satisfied by reaching
     * ANY member; the heuristic is the minimum over members, so a single A* search
     * naturally heads for the CLOSEST reachable one. This is how mining targets a
     * whole field of ore at once instead of greedily picking the nearest (which is
     * often the one walled in and unreachable).
     */
    static NavGoal composite(java.util.List<NavGoal> goals) {
        return new Composite(goals);
    }

    /** Any member, with equal-cost terminal cells selected by stable x/y/z order. */
    static NavGoal coordinateTiedComposite(java.util.List<NavGoal> goals) {
        return new CoordinateTiedComposite(goals);
    }

    /**
     * Stand in the ore's own column to mine it — a family of mining stance
     * goals, parameterised by how far BELOW the ore the feet may be:
     * <ul>
     *   <li>{@code maxBelow == 0} → feet exactly at the ore;</li>
     *   <li>{@code maxBelow == 1} → feet at the ore or one below;</li>
     *   <li>{@code maxBelow == 2} → feet at the ore, one, or two below.</li>
     * </ul>
     * Which one a given objective gets is decided by stance compilation:
     * the bottom
     * of a vertical run gets the exact ({@code maxBelow == 0}) stance so the body
     * mines it in place rather
     * than tunnelling under it. The vertical term in the heuristic folds the whole
     * accepted band to zero cost.
     */
    static NavGoal mineColumn(BlockPos ore, int maxBelow) {
        return new MineColumn(ore, maxBelow);
    }

    /** Loosest-stance shorthand (feet at the ore, one, or two below). */
    static NavGoal mine(BlockPos ore) {
        return mineColumn(ore, 2);
    }

    /**
     * Get as FAR as possible from {@code from} while holding a y-level —
     * used for branch mining: when no ore is
     * known, head out along the level to dig fresh tunnel and expose more. Never
     * "arrived" (isAt always false) so the search returns a best-effort partial that
     * walks outward; the next replan continues exploring.
     */
    static NavGoal runAway(BlockPos from, int maintainY) {
        return new RunAway(from, maintainY);
    }

    /**
     * Avoid a set of threats by standing outside each one's danger radius. Two differences from
     * {@link #runAway}: <b>it accounts for every threat</b> (runAway's estimate only looks at the nearest one,
     * so with one mob on each side it walks straight through one of them), and <b>it has an end point</b>: it
     * stops once outside the radii, so the upper layer need not stop it manually every tick.
     *
     * <p>Threat coordinates are a <b>snapshot</b>. Entity movement is followed by replanning ({@code PlayerNav}
     * compares the displacement of {@link #center()}), not by the heuristic in real time: an estimate that
     * changes during the search would break A*'s optimality guarantee.
     *
     * @param penaltyFactor potential field strength, see {@link GoalAvoidEntities}
     */
    static NavGoal avoid(double penaltyFactor, List<GoalAvoidEntities.Threat> threats) {
        return new Avoid(penaltyFactor, threats);
    }

    /**
     * Walk up to a target <b>while routing around other hostile mobs</b>. Arrival needs both: the approach is
     * reached, and the feet cell is not inside any threat's danger radius.
     *
     * <p>Callers must also put <b>the target itself</b> into {@code threats}: it attacks the Bot too, and its
     * own danger radius keeps the Bot just out of its reach; the gap in between is where kiting happens.
     *
     * @return {@code approach} itself when {@code threats} is empty, without an extra wrapper
     */
    static NavGoal approachAvoiding(NavGoal approach, double penaltyFactor,
                                    List<GoalAvoidEntities.Threat> threats) {
        return threats.isEmpty() ? approach : new ApproachAvoiding(approach, penaltyFactor, threats);
    }

    // ---- factory products (named, with readable parameters) ----

    /** Product of {@link #exact}: arrives only when all three axes match. */
    final class Exact implements NavGoal {
        public final BlockPos goal;

        Exact(BlockPos pos) {
            this.goal = pos.immutable();
        }

        @Override public boolean isAt(BlockPos feet) {
            return feet.equals(goal);
        }

        @Override public double heuristic(BlockPos from) {
            return pointBound(goal, from);
        }

        @Override public BlockPos center() {
            return goal;
        }
    }

    /** Product of {@link #column}: an XZ column at any height. */
    final class Column implements NavGoal {
        public final int x;
        public final int z;

        Column(int x, int z) {
            this.x = x;
            this.z = z;
        }

        @Override public boolean isAt(BlockPos feet) {
            return feet.getX() == x && feet.getZ() == z;
        }

        @Override public double heuristic(BlockPos from) {
            double dx = Math.abs(x - from.getX());
            double dz = Math.abs(z - from.getZ());
            return (Math.min(dx, dz) * SQRT_2 + Math.abs(dx - dz))
                    * COST_HEURISTIC;
        }

        @Override public BlockPos center() {
            return new BlockPos(x, 0, z);   // y irrelevant — goal is XZ-only
        }
    }

    /** Product of {@link #yLevel}: a Y level at any XZ. */
    final class YLevel implements NavGoal {
        public final int level;

        YLevel(int level) {
            this.level = level;
        }

        @Override public boolean isAt(BlockPos feet) {
            return feet.getY() == level;
        }

        @Override public double heuristic(BlockPos from) {
            int cy = from.getY();
            if (cy > level) return DESCEND_ONE_BLOCK * (cy - level);
            if (cy < level) return (level - cy) * JUMP_ONE_BLOCK;
            return 0.0;
        }

        @Override public BlockPos center() {
            return new BlockPos(0, level, 0);   // x/z irrelevant — goal is Y-only
        }
    }

    /** Product of {@link #near}: 3D Euclidean sphere neighborhood. */
    final class Near implements NavGoal {
        public final BlockPos goal;
        public final double radius;
        public final double radiusSqr;

        Near(BlockPos pos, double radius) {
            this.goal = pos.immutable();
            this.radius = radius;
            this.radiusSqr = radius * radius;
        }

        @Override public boolean isAt(BlockPos feet) {
            return feet.distSqr(goal) <= radiusSqr;
        }

        @Override public double heuristic(BlockPos from) {
            // The heuristic IS the full point bound — the radius
            // only relaxes isAt, it is NOT subtracted from the aim. (Slightly
            // inadmissible, deliberately: aiming at the centre keeps node ordering
            // and the best-so-far partial stable.)
            return pointBound(goal, from);
        }

        @Override public BlockPos center() {
            return goal;
        }
    }

    /** Product of {@link #ring}: ring-shaped standing band. */
    final class Ring implements NavGoal {
        public final BlockPos goal;
        public final double inner;
        public final double outer;

        Ring(BlockPos pos, double inner, double outer) {
            this.goal = pos.immutable();
            this.outer = outer;
            this.inner = inner >= outer ? 0.0 : inner;
        }

        private double horizontal(BlockPos p) {
            double dx = p.getX() - goal.getX();
            double dz = p.getZ() - goal.getZ();
            return Math.sqrt(dx * dx + dz * dz);
        }

        @Override public boolean isAt(BlockPos feet) {
            double d = horizontal(feet);
            return d >= inner && d <= outer;
        }

        /** Distance to the band, not to the center: outward when too close, inward when too far. */
        @Override public double heuristic(BlockPos from) {
            double d = horizontal(from);
            double gap = d < inner ? inner - d : d > outer ? d - outer : 0.0;
            return gap * NavSettings.get().costHeuristic;
        }

        @Override public BlockPos center() {
            return goal;
        }
    }

    /** Product of {@link #nearGround}: ground neighborhood of horizontal radius at the target height ±1. */
    final class NearGround implements NavGoal {
        public final BlockPos goal;
        public final double radius;
        public final double radiusSqr;

        NearGround(BlockPos pos, double radius) {
            this.goal = pos.immutable();
            this.radius = radius;
            this.radiusSqr = radius * radius;
        }

        @Override public boolean isAt(BlockPos feet) {
            int dy = feet.getY() - goal.getY();
            if (dy < -1 || dy > 1) return false;
            double dx = feet.getX() - goal.getX();
            double dz = feet.getZ() - goal.getZ();
            return dx * dx + dz * dz <= radiusSqr;
        }

        @Override public double heuristic(BlockPos from) {
            // Full point bound, radius not subtracted — same deliberate slight
            // inadmissibility as near(): aim at the centre for stable ordering.
            return pointBound(goal, from);
        }

        @Override public BlockPos center() {
            return goal;
        }
    }

    /** Product of {@link #adjacent}: horizontally orthogonal neighbor at the target height ±1. */
    final class Adjacent implements NavGoal {
        public final BlockPos goal;

        Adjacent(BlockPos target) {
            this.goal = target.immutable();
        }

        @Override public boolean isAt(BlockPos feet) {
            int dx = Math.abs(feet.getX() - goal.getX());
            int dz = Math.abs(feet.getZ() - goal.getZ());
            int dy = Math.abs(feet.getY() - goal.getY());
            return dx + dz == 1 && dy <= 1;
        }

        @Override public double heuristic(BlockPos from) {
            // One step + one jump of slack vs the point bound.
            return Math.max(0.0, pointBound(goal, from)
                    - COST_HEURISTIC - JUMP_ONE_BLOCK);
        }

        @Override public BlockPos center() {
            return goal;
        }
    }

    /** Product of {@link #mineStance}: touching it, with the feet no higher than it. */
    final class MineStance implements NavGoal {
        public final BlockPos ore;

        MineStance(BlockPos ore) {
            this.ore = ore.immutable();
        }

        @Override public boolean isAt(BlockPos feet) {
            int dy = feet.getY() - ore.getY();
            if (dy > 0) {
                return false;   // standing on top of it: that is the Bot's own floor
            }
            int dx = Math.abs(feet.getX() - ore.getX());
            int dz = Math.abs(feet.getZ() - ore.getZ());
            // Two-block body: with the feet below, the head cell also touches, so a negative dy folds by one
            int bodyDy = dy + 1 <= 0 ? dy + 1 : 0;
            return dx + dz + Math.abs(bodyDy) <= 1;
        }

        @Override public double heuristic(BlockPos from) {
            return Math.max(0.0, pointBound(ore, from) - COST_HEURISTIC - JUMP_ONE_BLOCK);
        }

        @Override public BlockPos center() {
            return ore;
        }

        @Override public String toString() {
            return "MineStance{" + ore.toShortString() + "}";
        }
    }

    /** Product of {@link #getToBlock}: body-height-corrected Manhattan touching neighborhood. */
    final class GetToBlock implements NavGoal {
        public final BlockPos goal;

        GetToBlock(BlockPos target) {
            this.goal = target.immutable();
        }

        @Override public boolean isAt(BlockPos feet) {
            int dx = Math.abs(feet.getX() - goal.getX());
            int dz = Math.abs(feet.getZ() - goal.getZ());
            int dy = feet.getY() - goal.getY();
            int bodyDy = dy < 0 ? dy + 1 : dy;
            return dx + dz + Math.abs(bodyDy) <= 1;
        }

        @Override public double heuristic(BlockPos from) {
            // One step + one jump of slack vs the point bound (same slack as
            // adjacent(): any accepted cell is at most that much off-centre).
            return Math.max(0.0, pointBound(goal, from)
                    - COST_HEURISTIC - JUMP_ONE_BLOCK);
        }

        @Override public BlockPos center() {
            return goal;
        }
    }

    /** Product of {@link #composite}: arrives when any member is satisfied; h is the minimum over members. */
    final class Composite implements NavGoal {
        public final java.util.List<NavGoal> members;
        private final BlockPos centroid;

        Composite(java.util.List<NavGoal> goals) {
            java.util.List<NavGoal> gs = java.util.List.copyOf(goals);
            if (gs.isEmpty()) {
                throw new IllegalArgumentException("composite goal needs at least one member");
            }
            // Centre = centroid of the members, NOT gs.get(0). The member list is
            // rebuilt every tick (ores re-sorted by distance as the body moves), so a
            // first-member centre would jitter and trip PlayerNav's goal-moved replan
            // every tick. The centroid only shifts when the SET changes (an ore mined
            // or found), which is what "the goal moved" should actually mean.
            long sx = 0, sy = 0, sz = 0;
            for (NavGoal g : gs) {
                BlockPos c = g.center();
                sx += c.getX();
                sy += c.getY();
                sz += c.getZ();
            }
            this.members = gs;
            this.centroid = new BlockPos(
                    (int) (sx / gs.size()), (int) (sy / gs.size()), (int) (sz / gs.size()));
        }

        @Override public boolean isAt(BlockPos feet) {
            for (NavGoal g : members) {
                if (g.isAt(feet)) return true;
            }
            return false;
        }

        @Override public double heuristic(BlockPos from) {
            double min = Double.MAX_VALUE;
            for (NavGoal g : members) {
                min = Math.min(min, g.heuristic(from));
            }
            return min;
        }

        @Override public BlockPos center() {
            return centroid;
        }
    }

    /** Composite whose equal-cost terminal cells have a stable coordinate order. */
    final class CoordinateTiedComposite implements NavGoal {
        private final Composite delegate;

        CoordinateTiedComposite(java.util.List<NavGoal> goals) {
            this.delegate = new Composite(goals);
        }

        @Override public boolean isAt(BlockPos feet) {
            return delegate.isAt(feet);
        }

        @Override public double heuristic(BlockPos from) {
            return delegate.heuristic(from);
        }

        @Override public BlockPos center() {
            return delegate.center();
        }

        @Override public boolean ordersEqualCostGoals() {
            return true;
        }

        @Override public int compareEqualCostGoals(BlockPos left, BlockPos right) {
            return STABLE_COORDINATE_ORDER.compare(left, right);
        }
    }

    /** Product of {@link #mineColumn}: ore-column standing band (feet from the ore down to maxBelow below). */
    final class MineColumn implements NavGoal {
        public final BlockPos ore;
        public final int maxBelow;

        MineColumn(BlockPos ore, int maxBelow) {
            this.ore = ore.immutable();
            this.maxBelow = maxBelow;
        }

        @Override public boolean isAt(BlockPos feet) {
            return feet.getX() == ore.getX() && feet.getZ() == ore.getZ()
                    && feet.getY() <= ore.getY() && feet.getY() >= ore.getY() - maxBelow;
        }

        @Override public double heuristic(BlockPos from) {
            double dx = Math.abs(ore.getX() - from.getX());
            double dz = Math.abs(ore.getZ() - from.getZ());
            double horizontal = (Math.min(dx, dz) * SQRT_2 + Math.abs(dx - dz))
                    * COST_HEURISTIC;
            // Feet anywhere in {o.y .. o.y-maxBelow} count as arrived: fold that
            // band to zero.
            int yDiff = from.getY() - ore.getY();
            int adj = yDiff >= 0 ? yDiff : Math.min(0, yDiff + maxBelow);
            // Above the goal (adj>0) we DESCEND to it,
            // below it (adj<0) we ASCEND. (Swapping the two would overestimate
            // descents — an inadmissible heuristic.)
            double vertical = adj > 0
                    ? adj * DESCEND_ONE_BLOCK
                    : -adj * JUMP_ONE_BLOCK;
            return horizontal + vertical;
        }

        @Override public BlockPos center() {
            return ore;
        }
    }

    /**
     * Product of {@link #avoid}. Membership and estimate are <b>both delegated to the engine goal</b> rather
     * than duplicating the formula here: if one potential field were computed in two places, tuning would
     * inevitably update only one.
     */
    final class Avoid implements NavGoal {
        public final GoalAvoidEntities engine;
        private final BlockPos centroid;

        Avoid(double penaltyFactor, List<GoalAvoidEntities.Threat> threats) {
            this.engine = new GoalAvoidEntities(penaltyFactor,
                    threats.toArray(GoalAvoidEntities.Threat[]::new));
            double x = 0.0;
            double y = 0.0;
            double z = 0.0;
            for (GoalAvoidEntities.Threat t : threats) {
                x += t.x();
                y += t.y();
                z += t.z();
            }
            int n = threats.size();
            this.centroid = BlockPos.containing(x / n, y / n, z / n);
        }

        @Override public boolean isAt(BlockPos feet) {
            return engine.isInGoal(feet.getX(), feet.getY(), feet.getZ());
        }

        @Override public double heuristic(BlockPos fromPos) {
            return engine.heuristic(fromPos.getX(), fromPos.getY(), fromPos.getZ());
        }

        /** Centroid of the threats: moving it triggers a replan, so the snapshot never gets too stale. */
        @Override public BlockPos center() {
            return centroid;
        }
    }

    /** Product of {@link #approachAvoiding}. Membership comes from the attraction term; the estimate is the
     *  attraction term plus the potential field. */
    final class ApproachAvoiding implements NavGoal {
        public final NavGoal approach;
        public final GoalAvoidEntities repulsion;

        ApproachAvoiding(NavGoal approach, double penaltyFactor,
                         List<GoalAvoidEntities.Threat> threats) {
            this.approach = approach;
            this.repulsion = new GoalAvoidEntities(penaltyFactor,
                    threats.toArray(GoalAvoidEntities.Threat[]::new));
        }

        /** Approach reached and the feet cell is outside every danger radius. See GoalApproachAvoiding. */
        @Override public boolean isAt(BlockPos feet) {
            return approach.isAt(feet)
                    && repulsion.isInGoal(feet.getX(), feet.getY(), feet.getZ());
        }

        @Override public double heuristic(BlockPos fromPos) {
            return approach.heuristic(fromPos)
                    + repulsion.heuristic(fromPos.getX(), fromPos.getY(), fromPos.getZ());
        }

        /** Progress only measures closing in on the target. The danger field says whether a route is worth
         *  taking, not how far along the Bot is. */
        @Override public double progressHeuristic(BlockPos fromPos) {
            return approach.progressHeuristic(fromPos);
        }

        /** Follows the approach target: when it moves, a replan is triggered. */
        @Override public BlockPos center() {
            return approach.center();
        }
    }

    /** Product of {@link #runAway}: flees outward while holding a height; never "arrives". */
    final class RunAway implements NavGoal {
        public final BlockPos from;
        public final int maintainY;

        RunAway(BlockPos from, int maintainY) {
            this.from = from.immutable();
            this.maintainY = maintainY;
        }

        @Override public boolean isAt(BlockPos feet) {
            return false;   // never done — keep exploring outward
        }

        @Override public double heuristic(BlockPos fromPos) {
            // Run-away heuristic: −(octile×weight) — negated so farther = lower h
            // = preferred — then blended with the y-hold term:
            // min*0.6 + yLevelTerm*1.5.
            double dx = Math.abs(from.getX() - fromPos.getX());
            double dz = Math.abs(from.getZ() - fromPos.getZ());
            double xz = (Math.min(dx, dz) * SQRT_2 + Math.abs(dx - dz))
                    * COST_HEURISTIC;
            double min = -xz;
            int cy = fromPos.getY();
            double yLevel = cy > maintainY ? (cy - maintainY) * DESCEND_ONE_BLOCK
                    : cy < maintainY ? (maintainY - cy) * JUMP_ONE_BLOCK : 0.0;
            return min * 0.6 + yLevel * 1.5;
        }

        @Override public BlockPos center() {
            return from;
        }
    }
}
