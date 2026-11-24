package dev.mcagent.runtime.core.pathing.goals;

import net.minecraft.core.BlockPos;

/**
 * Adjacent goal: reached next to the target block. The six neighbors, the cell itself, and the two cells
 * directly below all count (a negative yDiff is incremented before the test: the body is two blocks tall,
 * so feet one block lower still reach).
 */
public class GoalGetToBlock implements Goal {

    public final int x;
    public final int y;
    public final int z;

    public GoalGetToBlock(BlockPos pos) {
        this.x = pos.getX();
        this.y = pos.getY();
        this.z = pos.getZ();
    }

    @Override
    public boolean isInGoal(int x, int y, int z) {
        int xDiff = x - this.x;
        int yDiff = y - this.y;
        int zDiff = z - this.z;
        if (yDiff < 0) {
            yDiff++;
        }
        return Math.abs(xDiff) + Math.abs(yDiff) + Math.abs(zDiff) <= 1;
    }

    @Override
    public double heuristic(int x, int y, int z) {
        int xDiff = x - this.x;
        int yDiff = y - this.y;
        int zDiff = z - this.z;
        if (yDiff < 0) {
            yDiff++;
        }
        return GoalBlock.calculate(xDiff, yDiff, zDiff);
    }

    public BlockPos getGoalPos() {
        return new BlockPos(x, y, z);
    }

    @Override
    public String toString() {
        return String.format("GoalGetToBlock{x=%d,y=%d,z=%d}", x, y, z);
    }
}
