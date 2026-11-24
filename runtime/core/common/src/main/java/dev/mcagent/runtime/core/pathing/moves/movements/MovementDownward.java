package dev.mcagent.runtime.core.pathing.moves.movements;
import dev.mcagent.runtime.core.pathing.moves.AimGeometry;

import java.util.Set;

import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.moves.MovementHelper;
import dev.mcagent.runtime.core.pathing.moves.MovementState;
import dev.mcagent.runtime.core.pathing.moves.MovementStatus;
import dev.mcagent.runtime.core.pathing.moves.MutableMoveResult;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.FALL_N_BLOCKS_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.LADDER_DOWN_ONE_COST;

/** Dig down in place: mine the block underfoot and drop one cell (or climb one cell down a ladder/vine). */
public class MovementDownward extends Movement {

    /** Tick counter for the free-fall phase (no keys during the first 10 ticks). */
    private int numTicks = 0;

    public MovementDownward(ServerPlayer player, BlockPos src, BlockPos dest) {
        super(player, src, dest, new BlockPos[]{dest});
    }

    @Override
    public void reset() {
        super.reset();
        numTicks = 0;
    }

    /**
     * Cost. Infeasible if the master switch is off or the cell two below is not standable. A ladder/vine
     * underfoot costs a climb down; otherwise a one-block fall + mining underfoot (a falling block underfoot
     * will already be empty by execution time, so no falling chain is counted).
     */
    public static double cost(CalculationContext context, int x, int y, int z) {
        if (!context.allowDownward) {
            return COST_INF;
        }
        if (!MovementHelper.canWalkOn(context, x, y - 2, z)) {
            return COST_INF;
        }
        BlockState down = context.get(x, y - 1, z);
        Block downBlock = down.getBlock();
        if (downBlock == Blocks.LADDER || downBlock == Blocks.VINE) {
            return LADDER_DOWN_ONE_COST;
        } else {
            return FALL_N_BLOCKS_COST[1]
                    + MovementHelper.getMiningDurationTicks(context, x, y - 1, z, down, false);
        }
    }

    @Override
    public double calculateCost(CalculationContext context, MutableMoveResult result) {
        return cost(context, src.getX(), src.getY(), src.getZ());
    }

    @Override
    protected Set<BlockPos> calculateValidPositions() {
        return Set.of(src, dest);
    }

    @Override
    public MovementState updateState(MovementState state) {
        super.updateState(state);
        if (state.getStatus() != MovementStatus.RUNNING) {
            return state;
        }

        BlockPos feet = feet(player);
        if (feet.equals(dest)) {
            return state.setStatus(MovementStatus.SUCCESS);
        } else if (!playerInValidPosition()) {
            return state.setStatus(MovementStatus.UNREACHABLE);
        }
        double diffX = player.getX() - (dest.getX() + 0.5);
        double diffZ = player.getZ() - (dest.getZ() + 0.5);
        double ab = Math.sqrt(diffX * diffX + diffZ * diffZ);

        if (numTicks++ < 10 && ab < 0.2) {
            return state; // first 10 ticks and still centered: free fall, no keys
        }
        AimGeometry.moveTowards(player, state, positionsToBreak[0]);
        return state;
    }
}
