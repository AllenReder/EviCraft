package dev.mcagent.runtime.core.pathing.goals;

import net.minecraft.core.BlockPos;

/** Exact single-cell goal: reached only when all three coordinates match. */
public class GoalBlock implements Goal {

    public final int x;
    public final int y;
    public final int z;

    public GoalBlock(BlockPos pos) {
        this(pos.getX(), pos.getY(), pos.getZ());
    }

    public GoalBlock(int x, int y, int z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    @Override
    public boolean isInGoal(int x, int y, int z) {
        return x == this.x && y == this.y && z == this.z;
    }

    @Override
    public double heuristic(int x, int y, int z) {
        int xDiff = x - this.x;
        int yDiff = y - this.y;
        int zDiff = z - this.z;
        return calculate(xDiff, yDiff, zDiff);
    }

    /** Vertical part priced at the per-block climb/descend cost, horizontal part at diagonal distance. */
    public static double calculate(double xDiff, int yDiff, double zDiff) {
        double heuristic = 0;
        heuristic += GoalYLevel.calculate(0, yDiff);
        heuristic += GoalXZ.calculate(xDiff, zDiff);
        return heuristic;
    }

    public BlockPos getGoalPos() {
        return new BlockPos(x, y, z);
    }

    @Override
    public String toString() {
        return String.format("GoalBlock{x=%d,y=%d,z=%d}", x, y, z);
    }
}
