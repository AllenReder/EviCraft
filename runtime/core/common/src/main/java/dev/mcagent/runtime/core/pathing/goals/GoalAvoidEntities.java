package dev.mcagent.runtime.core.pathing.goals;

/**
 * Avoid a set of threats: reached when outside <b>each threat's own danger radius</b>. The heuristic is a
 * <b>potential field</b>: closer is more expensive, rising faster the closer it gets.
 *
 * <h2>Why a potential field instead of "run directly away"</h2>
 * {@link GoalRunAway}'s heuristic is the negated distance to the nearest threat, so it only sees the nearest
 * one; with mobs on both sides it runs straight through one of them. The potential field sums every threat's
 * contribution, so going around is cheap and going through is expensive.
 *
 * <h2>Each threat has its own radius</h2>
 * A spider reaches about half a block farther than a zombie; a lit creeper reaches several blocks farther. A
 * single shared value would have to be the maximum, making the Bot avoid zombies at spider distance. The
 * radius is derived from the hitbox by {@code Menace.dangerRadius}.
 *
 * <h2>Coordinates</h2>
 * Threats use <b>real entity coordinates</b>; candidate cells use the <b>cell center</b>. The radius already
 * includes the half block from cell center to the farthest point in the cell, so safe by cell center implies
 * safe at the actual position. If the danger check and the goal used different metrics, one would say
 * "retreat" while the other says "already there": navigation would arrive immediately without moving.
 *
 * <h2>Snapshot, not a live reference</h2>
 * Threat coordinates are copied <b>when the path starts</b> and do not change during the search. A* requires
 * each cell's estimate to be constant within one search; a heuristic that tracked live entities would give
 * the same cell different values and void any optimality guarantee. Stale positions are handled by
 * replanning ({@code PlayerNav}'s live-goal cadence), not by the heuristic.
 */
public class GoalAvoidEntities implements Goal {

    /**
     * Snapshot of one threat.
     *
     * <h2>Two distances for two purposes</h2>
     * <b>They must not be the same value</b>: a large flee clearance used as the penalty radius (32 blocks)
     * makes {@code applySpherical} enumerate 65^3 (about 270,000) cells per threat, millions of table inserts
     * with several mobs on every replan, which stalls the server.
     *
     * @param radius    <b>how close is expensive</b>: the danger radius, which sizes the edge-cost penalty
     *                  sphere and shapes the potential field. Two to three blocks, derived from the hitbox; see
     *                  {@code Menace.dangerRadius}
     * @param clearance <b>how far counts as clear</b>: the membership condition. For kiting it equals
     *                  {@code radius} (step out, then keep fighting); disengagement is decided by higher
     *                  layers and does not use this path
     */
    public record Threat(double x, double y, double z, double radius, double clearance) {
        public Threat {
            if (radius < 0.0 || clearance < 0.0) {
                throw new IllegalArgumentException("Distance cannot be negative: " + radius + " / " + clearance);
            }
        }

        /** Kiting: leaving the danger radius counts as clear, so both distances are equal. */
        public Threat(double x, double y, double z, double radius) {
            this(x, y, z, radius, radius);
        }

        /** Fleeing: the penalty sphere keeps its size, but clearance requires this larger distance. */
        public Threat withClearance(double newClearance) {
            return new Threat(x, y, z, radius, newClearance);
        }
    }

    /**
     * Potential when standing on a threat. A finite large value instead of letting 1/0 become infinity:
     * infinity would break heuristic comparisons (any two on-top cells would tie), while a finite value stays
     * comparable.
     */
    static final double ON_TOP_OF_THREAT = 1000.0;

    private final Threat[] threats;
    private final double penaltyFactor;

    /**
     * @param penaltyFactor strength of the potential field. <b>Larger</b>: the Bot detours more firmly;
     *                      <b>smaller</b>: the Bot brushes past threats for a shorter route. Must not exceed
     *                      the scale of path cost: the field enters only the heuristic, not edge costs, and
     *                      the heuristic must be a lower bound on remaining cost for A* to prune safely
     * @param threats       at least one
     */
    public GoalAvoidEntities(double penaltyFactor, Threat... threats) {
        if (threats.length == 0) {
            throw new IllegalArgumentException("An avoidance goal needs at least one threat");
        }
        this.threats = threats;
        this.penaltyFactor = penaltyFactor;
    }

    /**
     * Whether point {@code (x, z)} is far enough from {@code (threatX, threatZ)}.
     *
     * <p><b>This is the single definition of "far enough"</b>; both the goal and its callers use it. If the
     * "should retreat" check and the "has retreated" check used different metrics (e.g. exact 3D distance vs.
     * integer-truncated horizontal cell distance), one could report danger while the other reports arrival,
     * and navigation would finish immediately with the Bot circling in place.
     */
    public static boolean clearOf(double x, double z, double threatX, double threatZ,
                                  double radius) {
        double dx = x - threatX;
        double dz = z - threatZ;
        return dx * dx + dz * dz >= radius * radius;
    }

    /** The threats; the search builds <b>edge-cost</b> penalty spheres from them ({@code Avoidance.forGoal}). */
    public Threat[] threats() {
        return threats.clone();
    }

    /**
     * Clear only when at least {@code clearance} from <b>every</b> threat. Height is ignored, so standing
     * above a threat does not count as clear: explosions are spherical.
     */
    @Override
    public boolean isInGoal(int x, int y, int z) {
        for (Threat t : threats) {
            if (!clearOf(x + 0.5, z + 0.5, t.x(), t.z(), t.clearance())) {
                return false;
            }
        }
        return true;
    }

    /**
     * Potential field: <b>which direction is safer</b>. Distance is measured in multiples of the danger radius,
     * so a spider and a zombie at the edge of their radii have equal potential; the danger level is already
     * encoded in the radius and needs no separate weight.
     *
     * <h2>This is a heuristic, not a cost</h2>
     * The extra cost of entering dangerous cells lives in <b>edge costs</b> ({@code Avoidance.forGoal},
     * multiplied into {@code actionCost}). The field here matters only for goals <b>without an attraction
     * term</b> (backing off, fleeing): they have no destination, so the field is their only direction. Stance
     * goals with attraction ({@code GoalApproachAvoiding}) do not add it: the heuristic must be a lower bound
     * on remaining cost, and a term that does not decrease toward the target would make pruning unsafe.
     *
     * <h2>Summed, not averaged</h2>
     * Dividing by the threat count would make <b>each threat less worth avoiding as the crowd grows</b>:
     * detouring around an adjacent large slime costs about one extra block (path cost about 4.6), while with
     * four threats the averaged potential saved is only 4.49, so the Bot would sometimes walk straight into
     * the slime's 2.04-block hitbox, get stuck, and take contact damage every tick.
     *
     * <p>Danger is additive: four mobs around the Bot are more dangerous than one.
     */
    @Override
    public double heuristic(int x, int y, int z) {
        double sum = 0.0;
        for (Threat t : threats) {
            double dx = x + 0.5 - t.x();
            double dy = y - t.y();
            double dz = z + 0.5 - t.z();
            double span = Math.max(1.0, t.radius());
            double cost = (dx * dx + dy * dy + dz * dz) / (span * span);
            sum += cost <= 0.0 ? ON_TOP_OF_THREAT : 1.0 / cost;
        }
        return sum * penaltyFactor;
    }

    @Override
    public String toString() {
        return String.format("GoalAvoidEntities{n=%d,k=%.0f}", threats.length, penaltyFactor);
    }
}
