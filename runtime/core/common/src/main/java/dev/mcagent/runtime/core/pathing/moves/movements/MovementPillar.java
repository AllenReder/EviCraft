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
import dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.AirBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CarpetBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.LadderBlock;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.SlabType;
import net.minecraft.world.phys.Vec3;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.JUMP_ONE_BLOCK_COST;
import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.LADDER_UP_ONE_COST;

/** Pillar up one block: jump in place and place a block underfoot (or climb a ladder/vine/water column). */
public class MovementPillar extends Movement {

    public MovementPillar(ServerPlayer player, BlockPos src, BlockPos dest) {
        super(player, src, dest, new BlockPos[]{src.above(2)}, src);
    }

    /**
     * Cost. Four forms: climb a ladder/vine directly (mining overhead costs x5); swim up inside a water
     * column at the ladder price; otherwise pillar: jump + placement penalty + jump penalty + overhead
     * mining, with a small +0.1 penalty when pillaring over air. Infeasible on top of a ladder, on a bottom
     * slab, on water (under walk-on-water semantics), on a lily pad/carpet floating on fluid, or with a fence
     * gate overhead. An overhead falling column is mined only if the whole column is falling blocks.
     */
    public static double cost(CalculationContext context, int x, int y, int z) {
        BlockState fromState = context.get(x, y, z);
        Block from = fromState.getBlock();
        boolean ladder = from == Blocks.LADDER || from == Blocks.VINE;
        BlockState fromDown = context.get(x, y - 1, z);
        if (!ladder) {
            if (fromDown.getBlock() == Blocks.LADDER || fromDown.getBlock() == Blocks.VINE) {
                return COST_INF; // cannot pillar while standing on top of a ladder/vine
            }
            if (fromDown.getBlock() instanceof SlabBlock
                    && fromDown.getValue(SlabBlock.TYPE) == SlabType.BOTTOM) {
                return COST_INF; // a jump from a bottom slab does not gain a full block
            }
        }
        if (from == Blocks.VINE && !hasAgainst(context, x, y, z)) {
            return COST_INF; // a vine without a solid block on any side cannot be climbed
        }
        BlockState toBreak = context.get(x, y + 2, z);
        Block toBreakBlock = toBreak.getBlock();
        if (toBreakBlock instanceof FenceGateBlock) {
            return COST_INF; // a fence gate overhead can be neither jumped through nor cleanly mined
        }
        BlockState srcUp = null;
        if (MovementHelper.isWater(toBreak) && MovementHelper.isWater(fromState)) {
            srcUp = context.get(x, y + 1, z);
            if (MovementHelper.isWater(srcUp)) {
                return LADDER_UP_ONE_COST; // already in a water column; keep swimming up
            }
        }
        double placeCost = 0;
        if (!ladder) {
            // A block must be placed in the start cell itself
            placeCost = context.costOfPlacingAt(x, y, z, fromState);
            if (placeCost >= COST_INF) {
                return COST_INF;
            }
            if (fromDown.getBlock() instanceof AirBlock) {
                placeCost += 0.1; // small penalty for pillaring over air (1/200 s)
            }
        }
        if ((MovementHelper.isLiquid(fromState)
                        && !MovementHelper.canPlaceAgainst(context, x, y - 1, z, fromDown))
                || (MovementHelper.isLiquid(fromDown) && context.assumeWalkOnWater)) {
            // Cannot pillar when submerged with nothing to place against below, or when standing on water
            // under walk-on-water semantics
            return COST_INF;
        }
        if ((from == Blocks.LILY_PAD || from instanceof CarpetBlock)
                && !fromDown.getFluidState().isEmpty()) {
            return COST_INF; // going up would require removing the lily pad/carpet being stood on
        }
        double hardness = MovementHelper.getMiningDurationTicks(context, x, y + 2, z, toBreak, true);
        if (hardness >= COST_INF) {
            return COST_INF;
        }
        if (hardness != 0) {
            if (toBreakBlock == Blocks.LADDER || toBreakBlock == Blocks.VINE) {
                hardness = 0; // ladder/vine overhead: climb it, do not mine
            } else {
                BlockState check = context.get(x, y + 3, z);
                if (check.getBlock() instanceof FallingBlock) {
                    // A falling block one above the head cell: unless the whole column (including the upper
                    // body cell) is falling blocks cleared first, mining would collapse it onto the Bot
                    if (srcUp == null) {
                        srcUp = context.get(x, y + 1, z);
                    }
                    if (!(toBreakBlock instanceof FallingBlock)
                            || !(srcUp.getBlock() instanceof FallingBlock)) {
                        return COST_INF;
                    }
                }
            }
        }
        if (ladder) {
            return LADDER_UP_ONE_COST + hardness * 5; // mining while hanging on a ladder is very slow
        } else {
            return JUMP_ONE_BLOCK_COST + placeCost + context.jumpPenalty + hardness;
        }
    }

    /** Whether any of the four horizontal neighbors is a solid block (required to climb a vine). */
    public static boolean hasAgainst(CalculationContext context, int x, int y, int z) {
        return MovementHelper.isBlockNormalCube(context.get(x + 1, y, z))
                || MovementHelper.isBlockNormalCube(context.get(x - 1, y, z))
                || MovementHelper.isBlockNormalCube(context.get(x, y, z + 1))
                || MovementHelper.isBlockNormalCube(context.get(x, y, z - 1));
    }

    /** First solid block among the vine cell's four neighbors (the climbing face), or null. */
    public static BlockPos getAgainst(BlockGetter level, BlockPos vine) {
        if (MovementHelper.isBlockNormalCube(level.getBlockState(vine.north()))) {
            return vine.north();
        }
        if (MovementHelper.isBlockNormalCube(level.getBlockState(vine.south()))) {
            return vine.south();
        }
        if (MovementHelper.isBlockNormalCube(level.getBlockState(vine.east()))) {
            return vine.east();
        }
        if (MovementHelper.isBlockNormalCube(level.getBlockState(vine.west()))) {
            return vine.west();
        }
        return null;
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

        if (feet(player).getY() < src.getY()) {
            return state.setStatus(MovementStatus.UNREACHABLE);
        }

        var level = world;
        Vec3 eye = player.getEyePosition();
        BlockState fromDown = level.getBlockState(src);
        if (MovementHelper.isWater(fromDown)
                && MovementHelper.isWater(level.getBlockState(dest))) {
            // Water column: look at the target center above to stay centered while rising (the jump to rise
            // is pressed by the base class's common rule)
            Vec3 destCenter = AimGeometry.blockCenter(dest);
            state.setTarget(new MovementState.MovementTarget(
                    AimGeometry.yawTo(eye, destCenter),
                    AimGeometry.pitchTo(eye, destCenter), false));
            if (Math.abs(player.getX() - destCenter.x) > 0.2
                    || Math.abs(player.getZ() - destCenter.z) > 0.2) {
                state.setInput(Input.MOVE_FORWARD, true);
            }
            if (feet(player).equals(dest)) {
                return state.setStatus(MovementStatus.SUCCESS);
            }
            return state;
        }
        boolean ladder = fromDown.getBlock() == Blocks.LADDER || fromDown.getBlock() == Blocks.VINE;
        boolean vine = fromDown.getBlock() == Blocks.VINE;
        Vec3 placeCenter = AimGeometry.blockCenter(positionToPlace);
        float placePitch = AimGeometry.pitchTo(eye, placeCenter);
        if (!ladder) {
            // Only set the pitch to look at the placement point underfoot; keep the current yaw (pillaring
            // needs no turning)
            state.setTarget(new MovementState.MovementTarget(player.getYRot(), placePitch, true));
        }

        boolean blockIsThere = MovementHelper.canWalkOn(level, src) || ladder;
        if (ladder) {
            BlockPos against = vine
                    ? getAgainst(level, src)
                    : src.relative(fromDown.getValue(LadderBlock.FACING).getOpposite());
            if (against == null) {
                return state.setStatus(MovementStatus.UNREACHABLE); // vine without a climbing face
            }
            if (feet(player).equals(against.above())
                    || feet(player).equals(dest)) {
                return state.setStatus(MovementStatus.SUCCESS);
            }
            if (MovementHelper.isBottomSlab(level.getBlockState(src.below()))) {
                state.setInput(Input.JUMP, true); // reaching a ladder from a bottom slab needs a jump first
            }
            AimGeometry.moveTowards(player, state, against);
            if (player.tickCount % 10 == 0) {
                // Log the ladder branch: otherwise a stall here looks like a pillar doing nothing.
                dev.mcagent.runtime.core.Constants.LOG.debug(
                        "[mc_agent-pillar] climbing src={} against={} pos={} y={} vy={} onClimbable={}",
                        src.toShortString(), against.toShortString(),
                        feet(player).toShortString(), String.format("%.2f", player.getY()),
                        String.format("%.3f", player.getDeltaMovement().y),
                        player.onClimbable());
            }
            return state;
        } else {
            // Pillar: get the scaffolding block in hand first
            if (!MovementPlacement.selectForLocation(player, src, true)) {
                return state.setStatus(MovementStatus.UNREACHABLE);
            }

            double diffX = player.getX() - (dest.getX() + 0.5);
            double diffZ = player.getZ() - (dest.getZ() + 0.5);
            double dist = Math.sqrt(diffX * diffX + diffZ * diffZ);
            double flatMotion = Math.sqrt(player.getDeltaMovement().x * player.getDeltaMovement().x
                    + player.getDeltaMovement().z * player.getDeltaMovement().z);

            // Sneak only at the two moments it actually helps: when placing (above the target, crouch so the
            // Bot does not step off) and when standing on the pillar center waiting to jump. Never sneak while
            // repositioning: sneaking cuts speed to 30% and rotation steps per frame, so searching for the
            // center while crouched turns into circling it at a constant radius of about 0.24. Then dist
            // stays above 0.17, the jump branch is never reached, and "not jumped yet" stays true, a
            // self-locking cycle. Sneaking serves placement, not walking.
            // The crouch must be in place before the placement window opens: a sneak request takes effect
            // only on the next tick (pose updates in aiStep), and the window lasts only a few ticks around
            // the jump apex. Requesting the crouch only once above the target usually takes effect after the
            // Bot has passed or fallen out of the window, so the three conditions rarely line up. Crouch
            // while rising near the target height, so the block can be placed as soon as the window opens.
            boolean risingIntoWindow = player.getDeltaMovement().y > 0.0
                    && player.getY() > dest.getY() - 0.5;
            state.setInput(Input.SNEAK,
                    player.getY() > dest.getY()
                            || risingIntoWindow
                            || (dist <= 0.17 && player.getY() < src.getY() + 0.2));

            if (dist > 0.17) { // must stay below the 0.2 sneak edge protection, with margin
                // Off center (possibly stuck): fully look at the placement point and walk back
                state.setInput(Input.MOVE_FORWARD, true);
                state.setTarget(new MovementState.MovementTarget(
                        AimGeometry.yawTo(eye, placeCenter), placePitch, true));
            } else if (flatMotion < 0.05) {
                // Jump only once horizontal speed has settled; release jump at the target height
                state.setInput(Input.JUMP, player.getY() < dest.getY());
            }

            if (!blockIsThere) {
                BlockState frState = level.getBlockState(src);
                if (!(frState.getBlock() instanceof AirBlock || frState.canBeReplaced())) {
                    // The start cell holds a non-replaceable block: look at it only when a ray can see it;
                    // mining while jumping is five times slower, so stop jumping and break it
                    Vec3 aim = AimGeometry.reachableAimPoint(player, world, src);
                    if (aim != null) {
                        state.setTarget(new MovementState.MovementTarget(
                                AimGeometry.yawTo(eye, aim),
                                AimGeometry.pitchTo(eye, aim), true));
                    }
                    state.setInput(Input.JUMP, false);
                    state.setRouteMutation(new RouteMutation.Break(src));
                } else {
                    boolean crouched = player.isCrouching();
                    boolean looking = MovementPlacement.isLookingAt(player, src.below())
                            || MovementPlacement.isLookingAt(player, src);
                    boolean highEnough = player.getY() > dest.getY() + 0.1;
                    if (crouched && looking && highEnough) {
                        // Crouched, aimed and high enough: place the block
                        state.setRouteMutation(new RouteMutation.Place(src));
                        dev.mcagent.runtime.core.Constants.LOG.info(
                                "[mc_agent-pillar] place attempt src={} y={} sneak={} dist={}",
                                src.toShortString(),
                                String.format("%.2f", player.getY()), player.isShiftKeyDown(),
                                String.format("%.2f", dist));
                    } else if (player.tickCount % 10 == 0) {
                        // Instrumentation: log each of the three jump-placement conditions (every 500 ms)
                        dev.mcagent.runtime.core.Constants.LOG.info(
                                "[mc_agent-pillar] not ready src={} sneaking={} aimed={} highEnough={} y={} dy={} dist={} "
                                        + "hspeed={} onGround={} jumpRequested={} vy={} held={}",
                                src.toShortString(), crouched, looking, highEnough,
                                String.format("%.2f", player.getY()),
                                String.format("%.2f", player.getY() - dest.getY()),
                                String.format("%.2f", dist),
                                String.format("%.3f", flatMotion), player.onGround(),
                                state.getInputStates().getOrDefault(Input.JUMP, false),
                                String.format("%.3f", player.getDeltaMovement().y),
                                player.getMainHandItem().getItem());
                    }
                }
            }
        }

        if (feet(player).equals(dest) && blockIsThere) {
            dev.mcagent.runtime.core.Constants.LOG.info(
                    "[mc_agent-pillar] pillar succeeded src={} feet={}", src.toShortString(),
                    feet(player).toShortString());
            return state.setStatus(MovementStatus.SUCCESS);
        }
        return state;
    }

    /**
     * Jump placement widens the transient set (never narrows it): NO_SUPPORT is also transient. The
     * placement window lasts only a few ticks around the jump apex, so a PVA precheck failure before the
     * crouch/aim/height conditions line up does not mean placement is impossible. The base class's
     * transient limit keeps retries bounded.
     */
    @Override
    protected boolean isTransientFailure(PhysicalVerificationAuthority.Failure failure) {
        return switch (failure.code()) {
            case NO_SUPPORT -> true;
            default -> super.isTransientFailure(failure);
        };
    }

    /** Hold sneak while mining from a ladder/vine; skip preparation mining if there is water above dest. */
    @Override
    protected boolean prepared(MovementState state) {
        BlockPos feet = feet(player);
        if (feet.equals(src) || feet.equals(src.below())) {
            Block block = world.getBlockState(src.below()).getBlock();
            if (block == Blocks.LADDER || block == Blocks.VINE) {
                state.setInput(Input.SNEAK, true);
            }
        }
        if (MovementHelper.isWater(world.getBlockState(dest.above()))) {
            return true;
        }
        return super.prepared(state);
    }
}
