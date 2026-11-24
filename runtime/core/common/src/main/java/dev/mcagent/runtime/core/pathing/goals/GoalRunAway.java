package dev.mcagent.runtime.core.pathing.goals;

import net.minecraft.core.BlockPos;

/**
 * Run-away goal: reached when the XZ distance to every threat point is at least the given distance.
 * Optional maintainY also requires a fixed height. The heuristic is the negated XZ estimate to the nearest
 * threat point (farther is better); with maintainY the height term is blended in with weights 0.6/1.5.
 */
public class GoalRunAway implements Goal {

    private final BlockPos[] from;
    private final int distanceSq;
    private final Integer maintainY;

    public GoalRunAway(double distance, BlockPos... from) {
        this(distance, null, from);
    }

    public GoalRunAway(double distance, Integer maintainY, BlockPos... from) {
        if (from.length == 0) {
            throw new IllegalArgumentException("A run-away goal needs at least one threat point");
        }
        this.from = from;
        this.distanceSq = (int) (distance * distance);
        this.maintainY = maintainY;
    }

    @Override
    public boolean isInGoal(int x, int y, int z) {
        if (maintainY != null && maintainY != y) {
            return false;
        }
        for (BlockPos p : from) {
            int diffX = x - p.getX();
            int diffZ = z - p.getZ();
            int distSq = diffX * diffX + diffZ * diffZ;
            if (distSq < distanceSq) {
                return false;
            }
        }
        return true;
    }

    @Override
    public double heuristic(int x, int y, int z) {
        double min = Double.MAX_VALUE;
        for (BlockPos p : from) {
            double h = GoalXZ.calculate(p.getX() - x, p.getZ() - z);
            if (h < min) {
                min = h;
            }
        }
        min = -min;
        if (maintainY != null) {
            min = min * 0.6 + GoalYLevel.calculate(maintainY, y) * 1.5;
        }
        return min;
    }

    @Override
    public String toString() {
        return maintainY != null
                ? String.format("GoalRunAway{distSq=%d,y=%d}", distanceSq, maintainY)
                : String.format("GoalRunAway{distSq=%d}", distanceSq);
    }
}
