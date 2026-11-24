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

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.CENTER_AFTER_FALL_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.FALL_N_BLOCKS_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.LADDER_DOWN_ONE_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.WALK_OFF_BLOCK_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.WALK_ONE_BLOCK_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.WALK_ONE_OVER_SOUL_SAND_COST;

/** Descend: walk down to an adjacent cell one block lower; deeper drops are handed to fall semantics. */
public class MovementDescend extends Movement {

    /** Tick counter for the run-off phase (the first 20 ticks head for fakeDest to leave the edge faster). */
    private int numTicks = 0;
    /** Forced safe-mode flag injected by the execution layer based on the next movement. */
    private boolean forceSafeMode = false;

    public MovementDescend(ServerPlayer player, BlockPos src, BlockPos dest) {
        super(player, src, dest,
                new BlockPos[]{dest.above(2), dest.above(), dest}, dest.below());
    }

    @Override
    public void reset() {
        super.reset();
        numTicks = 0;
        forceSafeMode = false;
    }

    /** Called by the path executor: the next movement needs this descend to be done in safe mode. */
    public void forceSafeMode() {
        forceSafeMode = true;
    }

    /**
     * Cost. First sum the mining of three cells in order: below the destination / the destination / above
     * it (including the falling chain). Infeasible when starting from a ladder/vine. If the cell two below
     * is not standable, switch to the fall tiers. Infeasible if the destination is a ladder/vine or would be
     * frozen by Frost Walker (handled as a traverse instead); otherwise walk off the edge + fall one block.
     */
    public static void cost(CalculationContext context, int x, int y, int z,
                            int destX, int destZ, MutableMoveResult res) {
        double totalCost = 0;
        BlockState destDown = context.get(destX, y - 1, destZ);
        totalCost += MovementHelper.getMiningDurationTicks(context, destX, y - 1, destZ, destDown, false);
        if (totalCost >= COST_INF) {
            return;
        }
        totalCost += MovementHelper.getMiningDurationTicks(context, destX, y, destZ, false);
        if (totalCost >= COST_INF) {
            return;
        }
        // Of the three cells only the top one can trigger a falling chain
        totalCost += MovementHelper.getMiningDurationTicks(context, destX, y + 1, destZ, true);
        if (totalCost >= COST_INF) {
            return;
        }

        Block fromDown = context.get(x, y - 1, z).getBlock();
        if (fromDown == Blocks.LADDER || fromDown == Blocks.VINE) {
            return;
        }

        BlockState below = context.get(destX, y - 2, destZ);
        if (!MovementHelper.canWalkOn(context, destX, y - 2, destZ, below)) {
            // Still empty below: switch to the fall tiers
            dynamicFallCost(context, x, y, z, destX, destZ, totalCost, below, res);
            return;
        }

        if (destDown.getBlock() == Blocks.LADDER || destDown.getBlock() == Blocks.VINE) {
            return;
        }
        if (MovementHelper.canUseFrostWalker(context, destDown)) {
            return; // the water would freeze when walked over, so this step is really a traverse
        }

        // Walk half a block plus 0.3 to the edge; the remaining 0.2 overlaps with the fall
        double walk = WALK_OFF_BLOCK_COST;
        if (fromDown == Blocks.SOUL_SAND) {
            walk *= WALK_ONE_OVER_SOUL_SAND_COST / WALK_ONE_BLOCK_COST;
        }
        totalCost += walk + Math.max(FALL_N_BLOCKS_COST[1], CENTER_AFTER_FALL_COST);
        res.x = destX;
        res.y = y - 1;
        res.z = destZ;
        res.cost = totalCost;
    }

    /**
     * Fall tiers: scan down layer by layer. Water (passable, not flowing, not walk-on-water, with a floor
     * below) means landing in water. A ladder/vine (catchable only with net fall <= 11) resets the effective
     * fall speed and the scan continues. A standable cell with net fall within the no-water limit is a
     * landing. Beyond that limit, with a water bucket and within the bucket limit, add the bucket cost and
     * return true (a bucket must be placed during execution). Bottom slabs and non-standable cells (such as
     * lava) give up.
     */
    public static boolean dynamicFallCost(CalculationContext context, int x, int y, int z,
                                          int destX, int destZ, double frontBreak,
                                          BlockState below, MutableMoveResult res) {
        if (frontBreak != 0 && context.get(destX, y + 2, destZ).getBlock() instanceof FallingBlock) {
            // Mining the front wall would make this falling column collapse into the shaft (possibly filling
            // the water we would land in); give up
            return false;
        }
        if (!MovementHelper.canWalkThrough(context, destX, y - 2, destZ, below)) {
            return false;
        }
        double costSoFar = 0;
        int effectiveStartHeight = y;
        for (int fallHeight = 3; true; fallHeight++) {
            int newY = y - fallHeight;
            if (newY < context.worldBottom) {
                // In the End the fall may go into the void; do not read blocks outside the world
                return false;
            }
            boolean reachedMinimum = fallHeight >= context.minFallHeight;
            BlockState ontoBlock = context.get(destX, newY, destZ);
            // Net fall height after resets by ladders/vines
            int unprotectedFallHeight = fallHeight - (y - effectiveStartHeight);
            double tentativeCost = WALK_OFF_BLOCK_COST
                    + FALL_N_BLOCKS_COST[unprotectedFallHeight] + frontBreak + costSoFar;
            if (reachedMinimum && MovementHelper.isWater(ontoBlock)) {
                if (!MovementHelper.canWalkThrough(context, destX, newY, destZ, ontoBlock)) {
                    return false;
                }
                if (context.assumeWalkOnWater) {
                    return false;
                }
                if (MovementHelper.isFlowing(context.view, destX, newY, destZ, ontoBlock)) {
                    return false;
                }
                if (!MovementHelper.canWalkOn(context, destX, newY - 1, destZ)) {
                    // Water too shallow: the fall goes through and hits whatever is below
                    return false;
                }
                // Landing in water; no bucket needed
                res.x = destX;
                res.y = newY;
                res.z = destZ;
                res.cost = tentativeCost;
                return false;
            }
            if (unprotectedFallHeight <= 11
                    && (ontoBlock.getBlock() == Blocks.VINE || ontoBlock.getBlock() == Blocks.LADDER)) {
                // Ladders/vines cannot be caught with net fall > 11; catching one resets the fall speed
                costSoFar += FALL_N_BLOCKS_COST[unprotectedFallHeight - 1]; // to this cell's top (exclusive)
                costSoFar += LADDER_DOWN_ONE_COST;
                effectiveStartHeight = newY;
                continue;
            }
            if (MovementHelper.canWalkThrough(context, destX, newY, destZ, ontoBlock)) {
                continue;
            }
            if (!MovementHelper.canWalkOn(context, destX, newY, destZ, ontoBlock)) {
                return false; // lava and the like: neither passable nor standable
            }
            if (MovementHelper.isBottomSlab(ontoBlock)) {
                return false; // landing on a bottom slab is unreliable and deals extra fall damage
            }
            if (reachedMinimum && unprotectedFallHeight <= context.maxFallHeightNoWater + 1) {
                // At fallHeight=4 the cell above the landing is exactly three lower: the no-water limit.
                // A hard landing adds a pain penalty from vanilla damage (net fall - 3, 1 point per block):
                // non-lethal heights remain valid routes, but damage-free alternatives (stairs, step-by-step
                // descent) win automatically on cost.
                int fallDamage = Math.max(0, (unprotectedFallHeight - 1) - 3);
                res.x = destX;
                res.y = newY + 1;
                res.z = destZ;
                res.cost = tentativeCost + fallDamage * context.fallDamageCostPerPoint;
                return false;
            }
            if (reachedMinimum && context.hasWaterBucket
                    && unprotectedFallHeight <= context.maxFallHeightBucket + 1) {
                res.x = destX;
                res.y = newY + 1; // lands on the block at newY; the destination is the cell above it
                res.z = destZ;
                res.cost = tentativeCost + context.placeBucketCost();
                res.requiresWaterBucket = true;
                return true; // a water bucket must be placed during execution
            } else {
                return false;
            }
        }
    }

    @Override
    public double calculateCost(CalculationContext context, MutableMoveResult result) {
        cost(context, src.getX(), src.getY(), src.getZ(), dest.getX(), dest.getZ(), result);
        if (result.y != dest.getY()) {
            return COST_INF; // the destination is deeper; this position is a fall, not a descend
        }
        return result.cost;
    }

    @Override
    protected Set<BlockPos> calculateValidPositions() {
        return Set.of(src, dest.above(), dest);
    }

    @Override
    public MovementState updateState(MovementState state) {
        super.updateState(state);
        if (state.getStatus() != MovementStatus.RUNNING) {
            return state;
        }

        BlockPos feet = feet(player);
        BlockPos fakeDest = new BlockPos(dest.getX() * 2 - src.getX(), dest.getY(),
                dest.getZ() * 2 - src.getZ());
        boolean safeMode = safeMode();
        // A normal descend keeps the momentum handoff of overshooting one cell; safe mode means the next
        // movement must start from exactly dest.
        if ((feet.equals(dest) || !safeMode && feet.equals(fakeDest))
                && (MovementHelper.isLiquid(world.getBlockState(dest))
                        || player.getY() - dest.getY() < 0.5)) {
            // Report success only after actually landing; otherwise the next movement starts mid-air
            return state.setStatus(MovementStatus.SUCCESS);
        }
        if (safeMode) {
            // Safe mode: aim at 0.83 of the way from src to dest, not at dest itself, to avoid overshooting
            double aimX = (src.getX() + 0.5) * 0.17 + (dest.getX() + 0.5) * 0.83;
            double aimZ = (src.getZ() + 0.5) * 0.17 + (dest.getZ() + 0.5) * 0.83;
            float yaw = AimGeometry.yawTo(player.getEyePosition(),
                    new Vec3(aimX, dest.getY(), aimZ));
            state.setTarget(new MovementState.MovementTarget(yaw, player.getXRot(), false))
                    .setInput(Input.MOVE_FORWARD, true);
            return state;
        }
        double diffX = player.getX() - (dest.getX() + 0.5);
        double diffZ = player.getZ() - (dest.getZ() + 0.5);
        double ab = Math.sqrt(diffX * diffX + diffZ * diffZ);
        double x = player.getX() - (src.getX() + 0.5);
        double z = player.getZ() - (src.getZ() + 0.5);
        double fromStart = Math.sqrt(x * x + z * z);
        if (!feet.equals(dest) || ab > 0.25) {
            if (numTicks++ < 20 && fromStart < 1.25) {
                // First 20 ticks: head past the edge towards the overshoot point to leave it faster
                AimGeometry.moveTowards(player, state, fakeDest);
            } else {
                AimGeometry.moveTowards(player, state, dest);
            }
        }
        return state;
    }

    /**
     * Whether safe mode is needed: forced by the execution layer; or the cell beyond the destination is
     * "impassable, with two passable cells above" (running straight would get stuck in it); or the three
     * body cells ahead contain a dangerous cell.
     */
    public boolean safeMode() {
        if (forceSafeMode) {
            return true;
        }
        BlockPos into = destOvershoot();
        if (skipToAscend()) {
            return true;
        }
        for (int i = 0; i <= 2; i++) {
            if (MovementHelper.avoidWalkingInto(world.getBlockState(into.above(i)))) {
                return true;
            }
        }
        return false;
    }

    /** Whether overshooting would wedge into a step opening: a wall cell with two open cells above. */
    public boolean skipToAscend() {
        BlockPos into = destOvershoot();
        var level = world;
        return !MovementHelper.canWalkThrough(level, into)
                && MovementHelper.canWalkThrough(level, into.above())
                && MovementHelper.canWalkThrough(level, into.above(2));
    }

    /** One cell past dest in the same direction (the column a sprinting overshoot would hit). */
    private BlockPos destOvershoot() {
        int dx = dest.getX() - src.getX();
        int dz = dest.getZ() - src.getZ();
        return dest.offset(dx, 0, dz);
    }
}
