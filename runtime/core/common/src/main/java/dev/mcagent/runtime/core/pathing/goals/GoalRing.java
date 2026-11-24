package dev.mcagent.runtime.core.pathing.goals;

import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import net.minecraft.core.BlockPos;

/**
 * Ring stance: stand between {@code inner} and {@code outer} from the center.
 *
 * <h2>The point is the heuristic, not the membership test</h2>
 * Membership is just one sphere minus another. The hard part is the <b>heuristic</b>: positioning goes two
 * ways (too far means move in, too close means move out), and "distance to the center" only expresses the
 * first.
 *
 * <p>For melee a center-distance heuristic happens to work: the band is usually closer than the Bot, so
 * moving inward lowers the estimate in the same direction as the goal. For a bow it is reversed: the band is
 * 8 to 12 blocks out while a mob may be 0.7 blocks away, so every step outward raises the estimate. A* then
 * digs toward the center, exhausts its budget, and {@code bestSoFar} picks the node with the lowest
 * estimate, <b>which is the one closest to the mob</b>.
 *
 * <p>The heuristic here is the <b>distance to the band</b>: zero inside, decreasing toward the band from
 * both sides, so both directions have a guiding gradient.
 *
 * <h2>Vertical distance is ignored</h2>
 * Stance is horizontal: three blocks overhead is not "backed off", and three blocks below is not
 * "in contact".
 */
public class GoalRing implements Goal {

    public final int x;
    public final int z;
    public final double inner;
    public final double outer;

    /**
     * @param inner minimum distance from the center; when {@code inner >= outer} the goal degenerates to a
     *              solid disc (inner edge set to zero), e.g. a large slime outreaching the player, where no
     *              safe band exists
     */
    public GoalRing(BlockPos centre, double inner, double outer) {
        this.x = centre.getX();
        this.z = centre.getZ();
        this.outer = outer;
        this.inner = inner >= outer ? 0.0 : inner;
    }

    private double distanceTo(int px, int pz) {
        double dx = px + 0.5 - (x + 0.5);
        double dz = pz + 0.5 - (z + 0.5);
        return Math.sqrt(dx * dx + dz * dz);
    }

    @Override
    public boolean isInGoal(int px, int py, int pz) {
        double d = distanceTo(px, pz);
        return d >= inner && d <= outer;
    }

    /**
     * Distance to the <b>band</b>, not to the center. Zero inside; inside the inner edge it measures outward,
     * beyond the outer edge inward, so both sides decrease toward the band, consistent with membership.
     */
    @Override
    public double heuristic(int px, int py, int pz) {
        double d = distanceTo(px, pz);
        double gap = d < inner ? inner - d : d > outer ? d - outer : 0.0;
        return gap * NavSettings.get().costHeuristic;
    }

    @Override
    public String toString() {
        return String.format("GoalRing{x=%d,z=%d,band=[%.2f,%.2f]}", x, z, inner, outer);
    }
}
