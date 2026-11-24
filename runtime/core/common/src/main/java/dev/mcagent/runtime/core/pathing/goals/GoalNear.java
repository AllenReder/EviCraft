package dev.mcagent.runtime.core.pathing.goals;

import net.minecraft.core.BlockPos;

/** Spherical goal: reached when the squared 3D distance to the center is at most rangeSq. */
public class GoalNear implements Goal {

    public final int x;
    public final int y;
    public final int z;
    public final int rangeSq;

    public GoalNear(BlockPos pos, int range) {
        this.x = pos.getX();
        this.y = pos.getY();
        this.z = pos.getZ();
        this.rangeSq = range * range;
    }

    @Override
    public boolean isInGoal(int x, int y, int z) {
        int xDiff = x - this.x;
        int yDiff = y - this.y;
        int zDiff = z - this.z;
        return xDiff * xDiff + yDiff * yDiff + zDiff * zDiff <= rangeSq;
    }

    @Override
    public double heuristic(int x, int y, int z) {
        // Range is not subtracted: estimate the full cost to the center (still an optimistic approximation).
        int xDiff = x - this.x;
        int yDiff = y - this.y;
        int zDiff = z - this.z;
        return GoalBlock.calculate(xDiff, yDiff, zDiff);
    }

    @Override
    public String toString() {
        return String.format("GoalNear{x=%d,y=%d,z=%d,rangeSq=%d}", x, y, z, rangeSq);
    }
}
