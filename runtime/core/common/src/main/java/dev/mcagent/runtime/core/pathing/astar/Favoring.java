package dev.mcagent.runtime.core.pathing.astar;

import java.util.List;

import dev.mcagent.runtime.core.pathing.moves.CalculationContext;

import it.unimi.dsi.fastutil.longs.Long2DoubleOpenHashMap;
import net.minecraft.core.BlockPos;

/**
 * Destination cell hash → cost coefficient table, default 1.0. Two sources:
 * <ul>
 *   <li>backtrack: every cell on the previous path is discounted (backtrackCostFavoringCoefficient, default
 *       0.5), so on replanning the action cost along the old path is halved. This favors following the old
 *       route and suppresses path oscillation;</li>
 *   <li>avoidance: spherical cost penalties around mobs and spawners (mob radius 8 coefficient 1.5, spawner
 *       radius 16 coefficient 2.0, multiplied per sphere), controlled by the NavSettings.avoidance switch
 *       (off by default; when off the table holds only the backtrack discount).</li>
 * </ul>
 */
public final class Favoring {

    private final Long2DoubleOpenHashMap favorings;

    /** The discount coefficient comes from the context snapshot (backtrackCostFavoringCoefficient). */
    public Favoring(NavPath previous, CalculationContext context) {
        this(previous, context.backtrackCostFavoringCoefficient);
    }

    public Favoring(NavPath previous, double coefficient) {
        favorings = new Long2DoubleOpenHashMap();
        favorings.defaultReturnValue(1.0D);
        if (coefficient != 1D && previous != null) {
            for (BlockPos pos : previous.positions()) {
                favorings.put(PathNode.longHash(pos.getX(), pos.getY(), pos.getZ()), coefficient);
            }
        }
    }

    /**
     * Construction with avoidance spheres: build the table from the backtrack discount, then multiply each
     * sphere in (existing values inside it times coefficient). Both sources end up in one table.
     */
    public Favoring(NavPath previous, CalculationContext context, List<Avoidance> avoidances) {
        this(previous, context.backtrackCostFavoringCoefficient);
        if (avoidances != null) {
            for (Avoidance avoid : avoidances) {
                avoid.applySpherical(favorings);
            }
        }
    }

    /** Empty table with no preferences (first plan, no previous path) */
    public static Favoring empty() {
        return new Favoring(null, 1.0D);
    }

    public boolean isEmpty() {
        return favorings.isEmpty();
    }

    /** Looks up the {@link PathNode#longHash} key of (x,y,z); returns 1.0 on a miss. */
    public double calculate(long hash) {
        return favorings.get(hash);
    }
}
