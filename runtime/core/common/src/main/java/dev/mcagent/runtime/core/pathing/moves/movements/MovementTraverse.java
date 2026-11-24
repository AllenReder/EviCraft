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
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.AirBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CarpetBlock;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.LadderBlock;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.SlabType;
import net.minecraft.world.phys.Vec3;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.SNEAK_ONE_BLOCK_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.SPRINT_MULTIPLIER;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.WALK_ONE_BLOCK_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.WALK_ONE_OVER_SOUL_SAND_COST;

/** Traverse: walk to an adjacent cell at the same height, mining the body cells or bridging below if needed. */
public class MovementTraverse extends Movement {

    /** Whether the bridge block was there all along (false means this execution has to place it). */
    private boolean wasTheBridgeBlockAlwaysThere = true;

    public MovementTraverse(ServerPlayer player, BlockPos src, BlockPos dest) {
        super(player, src, dest, new BlockPos[]{dest.above(), dest}, dest.below());
    }

    @Override
    public void reset() {
        super.reset();
        wasTheBridgeBlockAlwaysThere = true;
    }

    /**
     * Cost. Walk branch: the landing is standable (or Frost Walker can freeze it); water uses the water
     * speed, soul sand at either end adds half a penalty each, walking on water adds a penalty, and sprinting
     * is allowed when both body cells are clear and not water. Mining while standing on a ladder/vine costs
     * x5. Bridge branch: placement requires a replaceable cell under the landing. With a side face (excluding
     * the direction we come from) it costs normal walking speed; with only the back face it costs sneak speed,
     * x(sneak/walk). A back-face placement is impossible from soul sand, a non-double slab, or water.
     */
    public static double cost(CalculationContext context, int x, int y, int z, int destX, int destZ) {
        BlockState pb0 = context.get(destX, y + 1, destZ);
        BlockState pb1 = context.get(destX, y, destZ);
        BlockState destOn = context.get(destX, y - 1, destZ);
        BlockState srcDown = context.get(x, y - 1, z);
        Block srcDownBlock = srcDown.getBlock();
        boolean standingOnABlock = MovementHelper.mustBeSolidToWalkOn(context, x, y - 1, z, srcDown);
        boolean frostWalker = standingOnABlock && !context.assumeWalkOnWater
                && MovementHelper.canUseFrostWalker(context, destOn);
        if (frostWalker || MovementHelper.canWalkOn(context, destX, y - 1, destZ, destOn)) {
            // Walk branch: the bridge is already there
            double WC = WALK_ONE_BLOCK_COST;
            boolean water = false;
            if (MovementHelper.isWater(pb0) || MovementHelper.isWater(pb1)) {
                WC = context.waterWalkSpeed;
                water = true;
            } else {
                if (destOn.getBlock() == Blocks.SOUL_SAND) {
                    WC += (WALK_ONE_OVER_SOUL_SAND_COST - WALK_ONE_BLOCK_COST) / 2;
                } else if (frostWalker) {
                    // Ice frozen by Frost Walker carries no walk-on-water penalty
                } else if (destOn.getBlock() == Blocks.WATER) {
                    WC += context.walkOnWaterOnePenalty;
                }
                if (srcDownBlock == Blocks.SOUL_SAND) {
                    WC += (WALK_ONE_OVER_SOUL_SAND_COST - WALK_ONE_BLOCK_COST) / 2;
                }
            }
            double hardness1 = MovementHelper.getMiningDurationTicks(context, destX, y, destZ, pb1, false);
            if (hardness1 >= COST_INF) {
                return COST_INF;
            }
            // Only the upper cell counts the falling chain: only mining it can make falling blocks drop
            double hardness2 = MovementHelper.getMiningDurationTicks(context, destX, y + 1, destZ, pb0, true);
            if (hardness1 == 0 && hardness2 == 0) {
                if (!water && context.canSprint) {
                    // Body cells clear and not in water: sprinting is possible (also on soul sand)
                    WC *= SPRINT_MULTIPLIER;
                }
                return WC;
            }
            if (srcDownBlock == Blocks.LADDER || srcDownBlock == Blocks.VINE) {
                // Mining while hanging on a ladder/vine is very slow
                hardness1 *= 5;
                hardness2 *= 5;
            }
            return WC + hardness1 + hardness2;
        } else {
            // Bridge branch: a block must be placed under the landing
            if (srcDownBlock == Blocks.LADDER || srcDownBlock == Blocks.VINE) {
                return COST_INF;
            }
            if (!MovementHelper.isReplaceable(destX, y - 1, destZ, destOn, context.loadedTest)) {
                return COST_INF;
            }
            boolean throughWater = MovementHelper.isWater(pb0) || MovementHelper.isWater(pb1);
            if (MovementHelper.isWater(destOn) && throughWater) {
                // In water and placing into water: not allowed by these water-walking semantics
                return COST_INF;
            }
            double placeCost = context.costOfPlacingAt(destX, y - 1, destZ, destOn);
            if (placeCost >= COST_INF) {
                return COST_INF;
            }
            double hardness1 = MovementHelper.getMiningDurationTicks(context, destX, y, destZ, pb1, false);
            if (hardness1 >= COST_INF) {
                return COST_INF;
            }
            double hardness2 = MovementHelper.getMiningDurationTicks(context, destX, y + 1, destZ, pb0, true);
            double WC = throughWater ? context.waterWalkSpeed : WALK_ONE_BLOCK_COST;
            for (int i = 0; i < 5; i++) {
                int againstX = destX + MovementPlacement.HORIZONTALS_AND_DOWN[i].getStepX();
                int againstY = y - 1 + MovementPlacement.HORIZONTALS_AND_DOWN[i].getStepY();
                int againstZ = destZ + MovementPlacement.HORIZONTALS_AND_DOWN[i].getStepZ();
                if (againstX == x && againstZ == z) {
                    // The face we come from is the back face, handled separately with sneaking
                    continue;
                }
                if (MovementHelper.canPlaceAgainst(context, againstX, againstY, againstZ)) {
                    // A side face exists; no sneaking needed
                    return WC + placeCost + hardness1 + hardness2;
                }
            }
            // Back face only (sneak out over the edge, turn around and place against the side of the block
            // just stood on)
            if (srcDownBlock == Blocks.SOUL_SAND
                    || (srcDownBlock instanceof SlabBlock && srcDown.getValue(SlabBlock.TYPE) != SlabType.DOUBLE)) {
                return COST_INF; // soul sand / non-double slab tops are lower; the back face cannot be aimed at
            }
            if (!standingOnABlock) {
                return COST_INF; // cannot sneak-place on the back face while standing on water
            }
            Block blockSrc = context.getBlock(x, y, z);
            if ((blockSrc == Blocks.LILY_PAD || blockSrc instanceof CarpetBlock)
                    && !srcDown.getFluidState().isEmpty()) {
                return COST_INF; // lily pads/carpet can be stood on but not placed against
            }
            WC = WC * (SNEAK_ONE_BLOCK_COST / WALK_ONE_BLOCK_COST); // sneak the whole way
            return WC + placeCost + hardness1 + hardness2;
        }
    }

    @Override
    public double calculateCost(CalculationContext context, MutableMoveResult result) {
        return cost(context, src.getX(), src.getY(), src.getZ(), dest.getX(), dest.getZ());
    }

    @Override
    protected Set<BlockPos> calculateValidPositions() {
        return Set.of(src, dest);
    }

    @Override
    public MovementState updateState(MovementState state) {
        super.updateState(state);
        var level = world;
        BlockState pb0 = level.getBlockState(positionsToBreak[0]);
        BlockState pb1 = level.getBlockState(positionsToBreak[1]);
        if (state.getStatus() != MovementStatus.RUNNING) {
            // During preparation (mining blocks ahead) the Bot may walk while mining, stopping once close
            if (!NavSettings.get().walkWhileBreaking) {
                return state;
            }
            if (state.getStatus() != MovementStatus.PREPPING) {
                return state;
            }
            if (MovementHelper.avoidWalkingInto(pb0) || MovementHelper.avoidWalkingInto(pb1)) {
                return state;
            }
            double dist = Math.max(Math.abs(player.getX() - (dest.getX() + 0.5)),
                    Math.abs(player.getZ() - (dest.getZ() + 0.5)));
            if (dist < 0.83) {
                return state; // already close
            }
            if (!state.getTarget().hasRotation()) {
                // Occasional: a falling block entity arrived late and no mining target is set yet
                return state;
            }
            // Yaw at the destination center, pitch from the mining target; a fixed pitch when both cells are
            // full blocks/air
            float yawToDest = AimGeometry.yawTo(player.getEyePosition(), AimGeometry.blockCenter(dest));
            float pitchToBreak = state.getTarget().getPitch();
            if (MovementHelper.isBlockNormalCube(pb0)
                    || (pb0.getBlock() instanceof AirBlock
                            && (MovementHelper.isBlockNormalCube(pb1) || pb1.getBlock() instanceof AirBlock))) {
                pitchToBreak = 26;
            }
            return state.setTarget(new MovementState.MovementTarget(yawToDest, pitchToBreak, true))
                    .setInput(Input.MOVE_FORWARD, true)
                    .setInput(Input.SPRINT, true);
        }

        // Sneak may have been held during preparation; release it
        state.setInput(Input.SNEAK, false);

        Block fd = level.getBlockState(src.below()).getBlock();
        boolean ladder = fd == Blocks.LADDER || fd == Blocks.VINE;

        // Wooden door: blocking and openable, so look at the door center and right-click
        if (pb0.getBlock() instanceof DoorBlock || pb1.getBlock() instanceof DoorBlock) {
            boolean notPassable = (pb0.getBlock() instanceof DoorBlock
                            && !MovementHelper.isDoorPassable(level, src, dest))
                    || (pb1.getBlock() instanceof DoorBlock
                            && !MovementHelper.isDoorPassable(level, dest, src));
            boolean canOpen = !(pb0.getBlock() == Blocks.IRON_DOOR || pb1.getBlock() == Blocks.IRON_DOOR);
            if (notPassable && canOpen) {
                Vec3 center = AimGeometry.blockCenter(positionsToBreak[0]);
                return state.setTarget(new MovementState.MovementTarget(
                                AimGeometry.yawTo(player.getEyePosition(), center),
                                AimGeometry.pitchTo(player.getEyePosition(), center), true))
                        .setRouteMutation(new RouteMutation.Open(positionsToBreak[0]));
            }
        }

        // Fence gate: find the blocking one and right-click it only when a ray can see it; if it is not
        // visible at all, do not click and fall through to the walking logic below
        if (pb0.getBlock() instanceof FenceGateBlock || pb1.getBlock() instanceof FenceGateBlock) {
            BlockPos blocked = !MovementHelper.isGatePassable(level, positionsToBreak[0], src.above())
                    ? positionsToBreak[0]
                    : !MovementHelper.isGatePassable(level, positionsToBreak[1], src)
                            ? positionsToBreak[1]
                            : null;
            if (blocked != null) {
                Vec3 aim = AimGeometry.reachableAimPoint(player, world, blocked);
                if (aim != null) {
                    return state.setTarget(new MovementState.MovementTarget(
                                    AimGeometry.yawTo(player.getEyePosition(), aim),
                                    AimGeometry.pitchTo(player.getEyePosition(), aim), true))
                            .setRouteMutation(new RouteMutation.Open(blocked));
                }
            }
        }

        boolean isTheBridgeBlockThere = MovementHelper.canWalkOn(level, positionToPlace)
                || ladder
                || MovementPlacement.canUseFrostWalker(player, level.getBlockState(positionToPlace));
        BlockPos feet = feet(player);
        if (feet.getY() != dest.getY() && !ladder) {
            // Wrong height: jump if too low, wait to fall if too high
            if (feet.getY() < dest.getY()) {
                return state.setInput(Input.JUMP, true);
            }
            return state;
        }

        if (isTheBridgeBlockThere) {
            if (feet.equals(dest)) {
                return state.setStatus(MovementStatus.SUCCESS);
            }
            BlockPos dir = getDirection();
            if (NavSettings.get().overshootTraverse
                    && (feet.equals(dest.offset(dir)) || feet.equals(dest.offset(dir).offset(dir)))) {
                // Overshooting by one or two cells also counts as success; no need to turn back
                return state.setStatus(MovementStatus.SUCCESS);
            }
            Block low = level.getBlockState(src).getBlock();
            Block high = level.getBlockState(src.above()).getBlock();
            if (player.getY() > src.getY() + 0.1 && !player.onGround()
                    && (low == Blocks.VINE || low == Blocks.LADDER
                            || high == Blocks.VINE || high == Blocks.LADDER)) {
                // Hanging off the ground on a ladder/vine: forward would climb up, so wait to land
                return state;
            }
            BlockPos into = dest.subtract(src).offset(dest);
            BlockState intoBelow = level.getBlockState(into);
            BlockState intoAbove = level.getBlockState(into.above());
            if (wasTheBridgeBlockAlwaysThere
                    && (!MovementHelper.isLiquid(level.getBlockState(feet)) || NavSettings.get().sprintInWater)
                    && (!MovementHelper.avoidWalkingInto(intoBelow) || MovementHelper.isWater(intoBelow))
                    && !MovementHelper.avoidWalkingInto(intoAbove)) {
                state.setInput(Input.SPRINT, true);
            }

            BlockState destDown = level.getBlockState(dest.below());
            BlockPos against = positionsToBreak[0];
            if (feet.getY() != dest.getY() && ladder
                    && (destDown.getBlock() == Blocks.VINE || destDown.getBlock() == Blocks.LADDER)) {
                // Moving onto a lower ladder/vine: walk towards its climbing face
                against = destDown.getBlock() == Blocks.VINE
                        ? MovementPillar.getAgainst(level, dest.below())
                        : dest.relative(destDown.getValue(LadderBlock.FACING).getOpposite());
                if (against == null) {
                    return state.setStatus(MovementStatus.UNREACHABLE);
                }
            }
            AimGeometry.moveTowards(player, state, against);
            return state;
        } else {
            // Bridge execution: the bridge block is missing (or was mined); place it now
            wasTheBridgeBlockAlwaysThere = false;
            Block standingOn = level.getBlockState(feet.below()).getBlock();
            if (standingOn == Blocks.SOUL_SAND || standingOn instanceof SlabBlock) {
                // Sneaking on a block with a lower top slips off easily; when close, walk backwards to hold
                double dist = Math.max(Math.abs(dest.getX() + 0.5 - player.getX()),
                        Math.abs(dest.getZ() + 0.5 - player.getZ()));
                if (dist < 0.85) { // 0.5 + 0.3 + tolerance
                    AimGeometry.moveTowards(player, state, dest);
                    return state.setInput(Input.MOVE_FORWARD, false)
                            .setInput(Input.MOVE_BACK, true);
                }
            }
            double dist1 = Math.max(Math.abs(player.getX() - (dest.getX() + 0.5)),
                    Math.abs(player.getZ() - (dest.getZ() + 0.5)));
            MovementPlacement.PlaceResult p = MovementPlacement.attemptToPlaceABlock(
                    state, player, world, dest.below(), false, true);
            if ((p == MovementPlacement.PlaceResult.READY_TO_PLACE || dist1 < 0.6)
                    && !NavSettings.get().assumeSafeWalk) {
                state.setInput(Input.SNEAK, true);
            }
            switch (p) {
                case READY_TO_PLACE: {
                    // Right-click only once sneaking is confirmed (crouch first, then place, to avoid slipping)
                    if (player.isCrouching() || NavSettings.get().assumeSafeWalk) {
                        state.setRouteMutation(new RouteMutation.Place(dest.below()));
                    }
                    return state;
                }
                case ATTEMPTING: {
                    if (dist1 > 0.83) {
                        // Not close yet: keep moving forward only while the placement target is straight ahead
                        float yaw = AimGeometry.yawTo(player.getEyePosition(),
                                AimGeometry.blockCenter(dest));
                        if (Math.abs(state.getTarget().getYaw() - yaw) < 0.1) {
                            return state.setInput(Input.MOVE_FORWARD, true);
                        }
                    } else if (MovementPlacement.isFacing(player, state.getTarget())) {
                        // Aimed but still cannot place: something is in the way, so break it
                        BlockPos blocker = crosshairBlock();
                        return blocker == null ? state
                                : state.setRouteMutation(new RouteMutation.Break(blocker));
                    }
                    return state;
                }
                default:
                    break;
            }
            if (feet.equals(dest)) {
                // Sneaking over the target cell: turn back and place against the side of the block under src
                // (back face)
                double faceX = (dest.getX() + src.getX() + 1.0) * 0.5;
                double faceY = (dest.getY() + src.getY() - 1.0) * 0.5;
                double faceZ = (dest.getZ() + src.getZ() + 1.0) * 0.5;
                Vec3 face = new Vec3(faceX, faceY, faceZ);
                BlockPos goalLook = src.below(); // the block just stood on is the one to place against
                float facePitch = AimGeometry.pitchTo(player.getEyePosition(), face);
                double dist2 = Math.max(Math.abs(player.getX() - faceX),
                        Math.abs(player.getZ() - faceZ));
                if (dist2 < 0.29) {
                    // Too close to aim at the face: reverse the yaw and back up to gain distance
                    float yaw = AimGeometry.yawTo(AimGeometry.blockCenter(dest),
                            player.getEyePosition());
                    state.setTarget(new MovementState.MovementTarget(yaw, facePitch, true));
                    state.setInput(Input.MOVE_BACK, true);
                } else {
                    state.setTarget(new MovementState.MovementTarget(
                            AimGeometry.yawTo(player.getEyePosition(), face), facePitch, true));
                }
                if (MovementPlacement.isLookingAt(player, goalLook)) {
                    return state.setRouteMutation(new RouteMutation.Place(dest.below()));
                }
                if (MovementPlacement.isFacing(player, state.getTarget())) {
                    // Aimed but still failing: something blocks the line of sight, so break it
                    BlockPos blocker = crosshairBlock();
                    if (blocker != null) {
                        state.setRouteMutation(new RouteMutation.Break(blocker));
                    }
                }
                return state;
            }
            AimGeometry.moveTowards(player, state, positionsToBreak[0]);
            return state;
        }
    }

    /** Not interruptible while sneak-placing over the edge; interruptible otherwise. */
    @Override
    protected boolean safeToCancel(MovementState state) {
        return state.getStatus() != MovementStatus.RUNNING
                || MovementHelper.canWalkOn(world, dest.below());
    }

    /** Hold sneak while mining from a ladder/vine to avoid slipping. */
    @Override
    protected boolean prepared(MovementState state) {
        BlockPos feet = feet(player);
        if (feet.equals(src) || feet.equals(src.below())) {
            Block block = world.getBlockState(src.below()).getBlock();
            if (block == Blocks.LADDER || block == Blocks.VINE) {
                state.setInput(Input.SNEAK, true);
            }
        }
        return super.prepared(state);
    }
}
