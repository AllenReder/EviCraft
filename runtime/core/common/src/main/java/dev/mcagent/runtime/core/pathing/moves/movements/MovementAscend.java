package dev.mcagent.runtime.core.pathing.moves.movements;
import dev.mcagent.runtime.core.pathing.moves.AimGeometry;
import dev.mcagent.runtime.core.pathing.execute.RouteMutation;

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
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.state.BlockState;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.JUMP_ONE_BLOCK_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.WALK_ONE_BLOCK_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.WALK_ONE_OVER_SOUL_SAND_COST;

/** Ascend: jump onto a horizontally adjacent cell one block higher, placing a block under it if needed. */
public class MovementAscend extends Movement {

    /** Consecutive ticks a needed placement has not happened yet (for backing off and cancel protection). */
    private int ticksWithoutPlacement = 0;

    public MovementAscend(ServerPlayer player, BlockPos src, BlockPos dest) {
        super(player, src, dest,
                new BlockPos[]{dest, src.above(2), dest.above()}, dest.below());
    }

    @Override
    public void reset() {
        super.reset();
        ticksWithoutPlacement = 0;
    }

    /**
     * Cost. If the destination is not standable, add a placement (the face enumeration excludes the
     * direction we come from, since that block will have been mined). Infeasible if there is a falling block
     * three above the head that does not form an "already cleared falling column"; infeasible from a
     * ladder/vine, or from a bottom slab unless the target is a bottom slab. The three bottom-slab branches
     * and the soul sand jump slowdown use their own speeds; a normal jump includes the jump penalty. Then add
     * the mining cost of three cells.
     */
    public static double cost(CalculationContext context, int x, int y, int z, int destX, int destZ) {
        BlockState toPlace = context.get(destX, y, destZ);
        double additionalPlacementCost = 0;
        if (!MovementHelper.canWalkOn(context, destX, y, destZ, toPlace)) {
            additionalPlacementCost = context.costOfPlacingAt(destX, y, destZ, toPlace);
            if (additionalPlacementCost >= COST_INF) {
                return COST_INF;
            }
            if (!MovementHelper.isReplaceable(destX, y, destZ, toPlace, context.loadedTest)) {
                return COST_INF;
            }
            boolean foundPlaceOption = false;
            for (int i = 0; i < 5; i++) {
                int againstX = destX + MovementPlacement.HORIZONTALS_AND_DOWN[i].getStepX();
                int againstY = y + MovementPlacement.HORIZONTALS_AND_DOWN[i].getStepY();
                int againstZ = destZ + MovementPlacement.HORIZONTALS_AND_DOWN[i].getStepZ();
                if (againstX == x && againstZ == z) {
                    // The block we come from will have been mined by then; it cannot be a placement face
                    continue;
                }
                if (MovementHelper.canPlaceAgainst(context, againstX, againstY, againstZ)) {
                    foundPlaceOption = true;
                    break;
                }
            }
            if (!foundPlaceOption) {
                return COST_INF;
            }
        }
        BlockState srcUp2 = context.get(x, y + 2, z);
        if (context.get(x, y + 3, z).getBlock() instanceof FallingBlock
                && (MovementHelper.canWalkThrough(context, x, y + 1, z)
                        || !(srcUp2.getBlock() instanceof FallingBlock))) {
            // A falling column collapsing overhead during the jump would suffocate the Bot. Only allow it
            // when src.above is impassable and src.above(2) is also a falling block, which means the whole
            // column is cleared during preparation
            return COST_INF;
        }
        BlockState srcDown = context.get(x, y - 1, z);
        if (srcDown.getBlock() == Blocks.LADDER || srcDown.getBlock() == Blocks.VINE) {
            return COST_INF;
        }
        // Jumping from soul sand works; jumping from a bottom slab does not gain a full block
        boolean jumpingFromBottomSlab = MovementHelper.isBottomSlab(srcDown);
        boolean jumpingToBottomSlab = MovementHelper.isBottomSlab(toPlace);
        if (jumpingFromBottomSlab && !jumpingToBottomSlab) {
            return COST_INF; // from a bottom slab one can only ascend onto another bottom slab
        }
        double walk;
        if (jumpingToBottomSlab) {
            if (jumpingFromBottomSlab) {
                walk = Math.max(JUMP_ONE_BLOCK_COST, WALK_ONE_BLOCK_COST);
                walk += context.jumpPenalty;
            } else {
                walk = WALK_ONE_BLOCK_COST; // full block to bottom slab: walk in without jumping
            }
        } else {
            if (toPlace.getBlock() == Blocks.SOUL_SAND) {
                walk = WALK_ONE_OVER_SOUL_SAND_COST;
            } else {
                walk = Math.max(JUMP_ONE_BLOCK_COST, WALK_ONE_BLOCK_COST);
            }
            walk += context.jumpPenalty;
        }

        double totalCost = walk + additionalPlacementCost;
        // No falling-block check for the head cell: the check above already rejects the dangerous cases
        totalCost += MovementHelper.getMiningDurationTicks(context, x, y + 2, z, srcUp2, false);
        if (totalCost >= COST_INF) {
            return COST_INF;
        }
        totalCost += MovementHelper.getMiningDurationTicks(context, destX, y + 1, destZ, false);
        if (totalCost >= COST_INF) {
            return COST_INF;
        }
        totalCost += MovementHelper.getMiningDurationTicks(context, destX, y + 2, destZ, true);
        return totalCost;
    }

    @Override
    public double calculateCost(CalculationContext context, MutableMoveResult result) {
        return cost(context, src.getX(), src.getY(), src.getZ(), dest.getX(), dest.getZ());
    }

    /** Includes the back-off placement position and the chained-jump positions. */
    @Override
    protected Set<BlockPos> calculateValidPositions() {
        BlockPos dir = getDirection();
        // prior = src minus the climb direction, then up one: pillar back-off placement, sprint ascend and
        // skip-descend landings pass through here (dir.y=1, so subtract gives y-1 and above returns to src
        // height)
        BlockPos prior = src.subtract(dir).above();
        return Set.of(src, src.above(), dest, prior, prior.above());
    }

    @Override
    public MovementState updateState(MovementState state) {
        if (feet(player).getY() < src.getY()) {
            // Fell down: unreachable even if still in the mining preparation phase
            return state.setStatus(MovementStatus.UNREACHABLE);
        }
        super.updateState(state);
        if (state.getStatus() != MovementStatus.RUNNING) {
            return state;
        }

        var level = world;
        BlockPos feet = feet(player);
        BlockPos dir = getDirection();
        if (feet.equals(dest) || feet.equals(dest.offset(dir.getX(), dir.getY() - 1, dir.getZ()))) {
            // Arrived, or overshot to one cell ahead on the same level (climb direction Y=1, minus 1 is the
            // same level): also success
            return state.setStatus(MovementStatus.SUCCESS);
        }

        BlockState jumpingOnto = level.getBlockState(positionToPlace);
        if (!MovementHelper.canWalkOn(level, positionToPlace)) {
            // Destination block not there yet: place it while sneaking
            ticksWithoutPlacement++;
            if (MovementPlacement.attemptToPlaceABlock(state, player, world, dest.below(), false, true)
                    == MovementPlacement.PlaceResult.READY_TO_PLACE) {
                state.setInput(Input.SNEAK, true);
                if (player.isCrouching()) {
                    state.setRouteMutation(new RouteMutation.Place(dest.below()));
                }
            }
            if (ticksWithoutPlacement > 10) {
                // Not placed after ten ticks: most likely standing on the placement cell, so back off
                state.setInput(Input.MOVE_BACK, true);
            }
            return state;
        }
        AimGeometry.moveTowards(player, state, dest);
        if (MovementHelper.isBottomSlab(jumpingOnto)
                && !MovementHelper.isBottomSlab(level.getBlockState(src.below()))) {
            return state; // walking from a full block onto a bottom slab needs no jump
        }

        if (NavSettings.get().assumeStep || feet.equals(src.above())) {
            // Already in the air (or auto-step is available); no need to jump
            return state;
        }

        int xAxis = Math.abs(src.getX() - dest.getX());
        int zAxis = Math.abs(src.getZ() - dest.getZ());
        double flatDistToNext = xAxis * Math.abs((dest.getX() + 0.5) - player.getX())
                + zAxis * Math.abs((dest.getZ() + 0.5) - player.getZ());
        double sideDist = zAxis * Math.abs((dest.getX() + 0.5) - player.getX())
                + xAxis * Math.abs((dest.getZ() + 0.5) - player.getZ());

        double lateralMotion = xAxis * player.getDeltaMovement().z + zAxis * player.getDeltaMovement().x;
        if (player.tickCount % 10 == 0) {
            // Log each of the four ascend gates: when stuck here the only visible symptom is "not moving"
            dev.mcagent.runtime.core.Constants.LOG.debug(
                    "[mc_agent-ascend] src={} dest={} pos={} forward={} lateral={} drift={} headClear={} onGround={} standingOn={}",
                    src.toShortString(), dest.toShortString(), feet.toShortString(),
                    String.format("%.2f", flatDistToNext), String.format("%.2f", sideDist),
                    String.format("%.3f", lateralMotion), headBonkClear(), player.onGround(),
                    jumpingOnto.getBlock().builtInRegistryHolder().key().location().getPath());
        }
        if (Math.abs(lateralMotion) > 0.1) {
            return state; // still drifting sideways; straighten out before jumping
        }

        if (headBonkClear()) {
            return state.setInput(Input.JUMP, true); // all four cells around the head are clear; jump any time
        }

        if (flatDistToNext > 1.2 || sideDist > 0.2) {
            return state; // too far or off-axis; get closer first so an early jump does not hit the head
        }

        return state.setInput(Input.JUMP, true);
    }

    /** Whether the four horizontal neighbors of the cell two above src are clear (no head bonk on jump). */
    public boolean headBonkClear() {
        BlockPos startUp = src.above(2);
        for (int i = 0; i < 4; i++) {
            BlockPos check = startUp.relative(Direction.from2DDataValue(i));
            if (!MovementHelper.canWalkThrough(world, check)) {
                return false;
            }
        }
        return true;
    }

    /** Not interruptible once a placement has started (canceling midway would leave a pillar). */
    @Override
    protected boolean safeToCancel(MovementState state) {
        return state.getStatus() != MovementStatus.RUNNING || ticksWithoutPlacement == 0;
    }
}
