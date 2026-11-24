package dev.mcagent.runtime.core.pathing.moves.movements;
import dev.mcagent.runtime.core.pathing.moves.AimGeometry;

import java.util.Set;

import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.moves.Input;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.moves.MovementHelper;
import dev.mcagent.runtime.core.pathing.moves.MovementState;
import dev.mcagent.runtime.core.pathing.moves.MovementStatus;
import dev.mcagent.runtime.core.pathing.moves.MutableMoveResult;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.CENTER_AFTER_FALL_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.FALL_N_BLOCKS_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.JUMP_ONE_BLOCK_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.SPRINT_MULTIPLIER;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.WALK_ONE_BLOCK_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.WALK_ONE_OVER_SOUL_SAND_COST;

/** Diagonal step (level or +-1 block); never mines, and cuts the corner only where it is clear. */
public class MovementDiagonal extends Movement {

    private static final double SQRT_2 = Math.sqrt(2);

    public MovementDiagonal(ServerPlayer player, BlockPos src, BlockPos dest) {
        super(player, src, dest, buildPositionsToBreak(src, dest));
    }

    /** Two corner columns + the destination column (two cells each); never mined, only checked for clearance. */
    private static BlockPos[] buildPositionsToBreak(BlockPos src, BlockPos dest) {
        BlockPos cornerA = new BlockPos(src.getX(), src.getY(), dest.getZ());
        BlockPos cornerB = new BlockPos(dest.getX(), src.getY(), src.getZ());
        return new BlockPos[]{cornerA, cornerA.above(), cornerB, cornerB.above(), dest, dest.above()};
    }

    /**
     * Cost. The cell above the destination must be clear. Destination body cell blocked: diagonal ascend
     * tier (needs the switch + headroom). Landing not standable: diagonal descend tier (needs the switch +
     * a floor below). Soul sand at either end adds half a penalty each; the walk-on-water penalty is x sqrt(2);
     * lava under a cut corner is infeasible; in water the water speed overrides everything. Both corner
     * columns blocked is infeasible; one blocked detours at sqrt(2) - epsilon (slightly better than two
     * straight steps); all clear and not in water allows sprinting. Finally multiply by sqrt(2); the descend
     * tier adds the cost of falling one block.
     */
    public static void cost(CalculationContext context, int x, int y, int z,
                            int destX, int destZ, MutableMoveResult res) {
        if (!MovementHelper.canWalkThrough(context, destX, y + 1, destZ)) {
            return;
        }
        BlockState destInto = context.get(destX, y, destZ);
        BlockState fromDown;
        boolean ascend = false;
        BlockState destWalkOn;
        boolean descend = false;
        boolean frostWalker = false;
        if (!MovementHelper.canWalkThrough(context, destX, y, destZ, destInto)) {
            // Destination body cell blocked: can only be a diagonal ascend
            ascend = true;
            if (!context.allowDiagonalAscend
                    || !MovementHelper.canWalkThrough(context, x, y + 2, z)
                    || !MovementHelper.canWalkOn(context, destX, y, destZ, destInto)
                    || !MovementHelper.canWalkThrough(context, destX, y + 2, destZ)) {
                return;
            }
            destWalkOn = destInto;
            fromDown = context.get(x, y - 1, z);
        } else {
            destWalkOn = context.get(destX, y - 1, destZ);
            fromDown = context.get(x, y - 1, z);
            boolean standingOnABlock = MovementHelper.mustBeSolidToWalkOn(context, x, y - 1, z, fromDown);
            frostWalker = standingOnABlock && MovementHelper.canUseFrostWalker(context, destWalkOn);
            if (!frostWalker && !MovementHelper.canWalkOn(context, destX, y - 1, destZ, destWalkOn)) {
                // Landing not standable: can only be a diagonal descend
                descend = true;
                if (!context.allowDiagonalDescend
                        || !MovementHelper.canWalkOn(context, destX, y - 2, destZ)
                        || !MovementHelper.canWalkThrough(context, destX, y - 1, destZ, destWalkOn)) {
                    return;
                }
            }
            // Under walk-on-water semantics the water cannot be relied on to freeze (tightened only after
            // the descend tier check)
            frostWalker &= !context.assumeWalkOnWater;
        }
        double multiplier = WALK_ONE_BLOCK_COST;
        // Soul sand at each end affects half the distance
        if (destWalkOn.getBlock() == Blocks.SOUL_SAND) {
            multiplier += (WALK_ONE_OVER_SOUL_SAND_COST - WALK_ONE_BLOCK_COST) / 2;
        } else if (frostWalker) {
            // Ice frozen by Frost Walker has no penalty
        } else if (destWalkOn.getBlock() == Blocks.WATER) {
            multiplier += context.walkOnWaterOnePenalty * SQRT_2;
        }
        Block fromDownBlock = fromDown.getBlock();
        if (fromDownBlock == Blocks.LADDER || fromDownBlock == Blocks.VINE) {
            return;
        }
        if (fromDownBlock == Blocks.SOUL_SAND) {
            multiplier += (WALK_ONE_OVER_SOUL_SAND_COST - WALK_ONE_BLOCK_COST) / 2;
        }
        // The cells under the two cut corners must not be magma or lava; they would burn the Bot
        BlockState cuttingOver1 = context.get(x, y - 1, destZ);
        if (cuttingOver1.getBlock() == Blocks.MAGMA_BLOCK || MovementHelper.isLava(cuttingOver1)) {
            return;
        }
        BlockState cuttingOver2 = context.get(destX, y - 1, z);
        if (cuttingOver2.getBlock() == Blocks.MAGMA_BLOCK || MovementHelper.isLava(cuttingOver2)) {
            return;
        }
        boolean water = false;
        BlockState startState = context.get(x, y, z);
        Block startIn = startState.getBlock();
        if (MovementHelper.isWater(startState) || MovementHelper.isWater(destInto)) {
            if (ascend) {
                return;
            }
            // Floating in water, the ground no longer matters: override all earlier adjustments
            multiplier = context.waterWalkSpeed;
            water = true;
        }
        BlockState pb0 = context.get(x, y, destZ);
        BlockState pb2 = context.get(destX, y, z);
        if (ascend) {
            boolean aTop = MovementHelper.canWalkThrough(context, x, y + 2, destZ);
            boolean aMid = MovementHelper.canWalkThrough(context, x, y + 1, destZ);
            boolean aLow = MovementHelper.canWalkThrough(context, x, y, destZ, pb0);
            boolean bTop = MovementHelper.canWalkThrough(context, destX, y + 2, z);
            boolean bMid = MovementHelper.canWalkThrough(context, destX, y + 1, z);
            boolean bLow = MovementHelper.canWalkThrough(context, destX, y, z, pb2);
            if ((!(aTop && aMid && aLow) && !(bTop && bMid && bLow)) // both corner columns blocked
                    || MovementHelper.avoidWalkingInto(pb0)
                    || MovementHelper.avoidWalkingInto(pb2)
                    || (aTop && aMid && MovementHelper.canWalkOn(context, x, y, destZ, pb0)) // plain ascend works
                    || (bTop && bMid && MovementHelper.canWalkOn(context, destX, y, z, pb2))
                    || (!aTop && aMid && aLow) // head hits A
                    || (!bTop && bMid && bLow)) { // head hits B
                return;
            }
            res.cost = multiplier * SQRT_2 + JUMP_ONE_BLOCK_COST; // no jump penalty for the ascend tier
            res.x = destX;
            res.z = destZ;
            res.y = y + 1;
            return;
        }
        // Level/descend tier: evaluate both corner columns step by step with early pruning; if both need
        // mining it is infeasible (diagonals never mine)
        double optionA = MovementHelper.getMiningDurationTicks(context, x, y, destZ, pb0, false);
        double optionB = MovementHelper.getMiningDurationTicks(context, destX, y, z, pb2, false);
        if (optionA != 0 && optionB != 0) {
            return;
        }
        BlockState pb1 = context.get(x, y + 1, destZ);
        optionA += MovementHelper.getMiningDurationTicks(context, x, y + 1, destZ, pb1, true);
        if (optionA != 0 && optionB != 0) {
            return;
        }
        BlockState pb3 = context.get(destX, y + 1, z);
        if (optionA == 0 && ((MovementHelper.avoidWalkingInto(pb2) && pb2.getBlock() != Blocks.WATER)
                || MovementHelper.avoidWalkingInto(pb3))) {
            // With side A clear the Bot still brushes past side B: B must not be dangerous (water excepted)
            return;
        }
        optionB += MovementHelper.getMiningDurationTicks(context, destX, y + 1, z, pb3, true);
        if (optionA != 0 && optionB != 0) {
            return;
        }
        if (optionB == 0 && ((MovementHelper.avoidWalkingInto(pb0) && pb0.getBlock() != Blocks.WATER)
                || MovementHelper.avoidWalkingInto(pb1))) {
            return;
        }
        if (optionA != 0 || optionB != 0) {
            // One side blocked: the detour is about two straight steps; use sqrt(2) - epsilon so it is
            // slightly better than two traverses
            multiplier *= SQRT_2 - 0.001;
            if (startIn == Blocks.LADDER || startIn == Blocks.VINE) {
                // Moving sideways from a ladder/vine turns into climbing, so the detour fails
                return;
            }
        } else {
            // Sprint only when fully clear (not in water)
            if (context.canSprint && !water) {
                multiplier *= SPRINT_MULTIPLIER;
            }
        }
        res.cost = multiplier * SQRT_2;
        if (descend) {
            res.cost += Math.max(FALL_N_BLOCKS_COST[1], CENTER_AFTER_FALL_COST);
            res.y = y - 1;
        } else {
            res.y = y;
        }
        res.x = destX;
        res.z = destZ;
    }

    @Override
    public double calculateCost(CalculationContext context, MutableMoveResult result) {
        cost(context, src.getX(), src.getY(), src.getZ(), dest.getX(), dest.getZ(), result);
        if (result.y != dest.getY()) {
            return COST_INF; // height tier mismatch; this instance does not apply
        }
        return result.cost;
    }

    /** Level: src/dest/the two corners; ascend/descend tiers add the corresponding layer. */
    @Override
    protected Set<BlockPos> calculateValidPositions() {
        BlockPos diagA = new BlockPos(src.getX(), src.getY(), dest.getZ());
        BlockPos diagB = new BlockPos(dest.getX(), src.getY(), src.getZ());
        if (dest.getY() < src.getY()) {
            return Set.of(src, dest.above(), diagA, diagB, dest, diagA.below(), diagB.below());
        }
        if (dest.getY() > src.getY()) {
            return Set.of(src, src.above(), diagA, diagB, dest, diagA.above(), diagB.above());
        }
        return Set.of(src, dest, diagA, diagB);
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
        } else if (!playerInValidPosition()
                && !(MovementHelper.isLiquid(world.getBlockState(src))
                        && getValidPositions().contains(feet.above()))) {
            return state.setStatus(MovementStatus.UNREACHABLE);
        }
        if (dest.getY() > src.getY() && player.getY() < src.getY() + 0.1 && player.horizontalCollision) {
            state.setInput(Input.JUMP, true);
        }
        if (sprint()) {
            state.setInput(Input.SPRINT, true);
        }
        AimGeometry.moveTowards(player, state, dest);
        return state;
    }

    /** Sprint diagonally only when all four corner cells are clear (and not in water). */
    private boolean sprint() {
        var level = world;
        if (MovementHelper.isLiquid(level.getBlockState(feet(player)))
                && !NavSettings.get().sprintInWater) {
            return false;
        }
        for (int i = 0; i < 4; i++) {
            if (!MovementHelper.canWalkThrough(level, positionsToBreak[i])) {
                return false;
            }
        }
        return true;
    }

    /** Diagonals do no preparation mining. */
    @Override
    protected boolean prepared(MovementState state) {
        return true;
    }

    /** The to-break set is only the two destination cells (corner columns are squeezed past, not mined). */
    @Override
    public java.util.List<BlockPos> toBreak(net.minecraft.world.level.BlockGetter level) {
        if (toBreakCached != null) {
            return toBreakCached;
        }
        java.util.List<BlockPos> result = new java.util.ArrayList<>();
        for (int i = 4; i < 6; i++) {
            if (!MovementHelper.canWalkThrough(level, positionsToBreak[i])) {
                result.add(positionsToBreak[i]);
            }
        }
        toBreakCached = result;
        return result;
    }

    /** Corner column cells that are still not clear: where the body squeezes past. */
    @Override
    public java.util.List<BlockPos> toWalkInto(net.minecraft.world.level.BlockGetter level) {
        if (toWalkIntoCached == null) {
            toWalkIntoCached = new java.util.ArrayList<>();
        }
        java.util.List<BlockPos> result = new java.util.ArrayList<>();
        for (int i = 0; i < 4; i++) {
            if (!MovementHelper.canWalkThrough(level, positionsToBreak[i])) {
                result.add(positionsToBreak[i]);
            }
        }
        toWalkIntoCached = result;
        return toWalkIntoCached;
    }

    /**
     * When on a corner cell and neither corner has ground, check for support at the bounding-box corners
     * (+-0.25). No support means the Bot is hanging over the corner gap, and interrupting would drop it.
     */
    @Override
    protected boolean safeToCancel(MovementState state) {
        var level = world;
        BlockPos feet = feet(player);
        double offset = 0.25;
        double x = player.getX();
        double y = player.getY() - 1;
        double z = player.getZ();
        if (feet.equals(src)) {
            return true;
        }
        BlockPos cornerA = new BlockPos(src.getX(), src.getY() - 1, dest.getZ());
        BlockPos cornerB = new BlockPos(dest.getX(), src.getY() - 1, src.getZ());
        if (MovementHelper.canWalkOn(level, cornerA) && MovementHelper.canWalkOn(level, cornerB)) {
            return true;
        }
        if (feet.equals(new BlockPos(src.getX(), src.getY(), dest.getZ()))
                || feet.equals(new BlockPos(dest.getX(), src.getY(), src.getZ()))) {
            return MovementHelper.canWalkOn(level, BlockPos.containing(x + offset, y, z + offset))
                    || MovementHelper.canWalkOn(level, BlockPos.containing(x + offset, y, z - offset))
                    || MovementHelper.canWalkOn(level, BlockPos.containing(x - offset, y, z + offset))
                    || MovementHelper.canWalkOn(level, BlockPos.containing(x - offset, y, z - offset));
        }
        return true;
    }
}
