package dev.mcagent.runtime.core.pathing.moves.movements;
import dev.mcagent.runtime.core.pathing.moves.AimGeometry;

import java.util.HashSet;
import java.util.Set;

import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.cache.SpeculativeWorldView;
import dev.mcagent.runtime.core.pathing.moves.Input;
import dev.mcagent.runtime.core.pathing.moves.Movement;
import dev.mcagent.runtime.core.pathing.moves.MovementHelper;
import dev.mcagent.runtime.core.pathing.moves.MovementState;
import dev.mcagent.runtime.core.pathing.moves.MovementStatus;
import dev.mcagent.runtime.core.pathing.moves.MutableMoveResult;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.Vec3i;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LadderBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.WaterFluid;
import net.minecraft.world.phys.Vec3;

import static dev.mcagent.runtime.core.pathing.moves.ActionCosts.COST_INF;

/**
 * Fall of 2+ blocks: walk off the edge and drop to the destination; above the safe height, place a water
 * bucket mid-air to break the fall.
 */
public class MovementFall extends Movement {

    private boolean requiresWaterBucket;

    public MovementFall(ServerPlayer player, BlockPos src, BlockPos dest) {
        super(player, src, dest, buildPositionsToBreak(src, dest));
    }

    /** Cost reuses the descend fall tiers; if the destination differs, this instance does not apply. */
    @Override
    public double calculateCost(CalculationContext context, MutableMoveResult result) {
        MovementDescend.cost(context, src.getX(), src.getY(), src.getZ(),
                dest.getX(), dest.getZ(), result);
        if (result.y != dest.getY()) {
            return COST_INF; // this position is a descend, not a fall
        }
        if (result.cost < COST_INF
                && (!(context.view instanceof SpeculativeWorldView view) || !view.dependencyWasUnknown())) {
            requiresWaterBucket = result.requiresWaterBucket;
        }
        return result.cost;
    }

    /** src plus the whole column above the destination (the body passes through it during the fall). */
    @Override
    protected Set<BlockPos> calculateValidPositions() {
        Set<BlockPos> set = new HashSet<>();
        set.add(src);
        for (int y = src.getY() - dest.getY(); y >= 0; y--) {
            set.add(dest.above(y));
        }
        return set;
    }

    @Override
    public MovementState updateState(MovementState state) {
        super.updateState(state);
        if (state.getStatus() != MovementStatus.RUNNING) {
            return state;
        }

        var level = world;
        BlockPos feet = feet(player);
        Vec3 eye = player.getEyePosition();
        Vec3 destCenter = AimGeometry.blockCenter(dest);
        float toDestYaw = AimGeometry.yawTo(eye, destCenter);
        boolean forcedRotation = false;
        BlockState destState = level.getBlockState(dest);
        boolean isWater = destState.getFluidState().getType() instanceof WaterFluid;
        if (!isWater && willPlaceBucket() && !feet.equals(dest)) {
            int bucketSlot = hotbarSlotWith(Items.WATER_BUCKET);
            if (bucketSlot == -1 || player.level().dimension() == Level.NETHER) {
                return state.setStatus(MovementStatus.UNREACHABLE);
            }
            if (player.getY() - dest.getY() < NavSettings.get().blockReachDistance
                    && !player.onGround()) {
                // Destination within reach: switch to the bucket, aim straight down, place water on a hit
                player.getInventory().selected = bucketSlot;
                state.setTarget(new MovementState.MovementTarget(toDestYaw, 90.0f, true));
                forcedRotation = true;
                if (MovementPlacement.isLookingAt(player, dest)
                        || MovementPlacement.isLookingAt(player, dest.below())) {
                    state.setInput(Input.CLICK_RIGHT, true);
                }
            }
        }
        if (!forcedRotation) {
            state.setTarget(new MovementState.MovementTarget(toDestYaw,
                    AimGeometry.pitchTo(eye, destCenter), false));
        }
        if (feet.equals(dest) && (player.getY() - feet.getY() < 0.094 || isWater)) { // lily pad tolerance
            if (isWater) {
                // Landed in the water we placed: pick it up before moving on
                int emptySlot = hotbarSlotWith(Items.BUCKET);
                if (emptySlot != -1) {
                    player.getInventory().selected = emptySlot;
                    if (player.getDeltaMovement().y >= 0) {
                        return state.setInput(Input.CLICK_RIGHT, true);
                    }
                    return state; // still sinking; pick it up after surfacing
                } else {
                    if (player.getDeltaMovement().y >= 0) {
                        return state.setStatus(MovementStatus.SUCCESS);
                    }
                    // No early return while sinking: there may be a current below the surface; keep centering
                }
            } else {
                return state.setStatus(MovementStatus.SUCCESS);
            }
        }
        // Mid-air centering: if the predicted next-tick position is off by more than 0.1, push towards the
        // center; sneak to brake when vertical speed is high
        if (Math.abs(player.getX() + player.getDeltaMovement().x - destCenter.x) > 0.1
                || Math.abs(player.getZ() + player.getDeltaMovement().z - destCenter.z) > 0.1) {
            if (!player.onGround() && Math.abs(player.getDeltaMovement().y) > 0.4) {
                state.setInput(Input.SNEAK, true);
            }
            state.setInput(Input.MOVE_FORWARD, true);
        }
        // Ladder avoidance: with a ladder below, offset the aim point along the ladder's facing so the Bot
        // does not catch on it
        Direction avoidDir = avoid();
        Vec3i avoid = avoidDir == null ? null : avoidDir.getNormal();
        if (avoid == null) {
            avoid = src.subtract(dest);
        } else {
            double dist = Math.abs(avoid.getX() * (destCenter.x - avoid.getX() / 2.0 - player.getX()))
                    + Math.abs(avoid.getZ() * (destCenter.z - avoid.getZ() / 2.0 - player.getZ()));
            if (dist < 0.6) {
                state.setInput(Input.MOVE_FORWARD, true);
            } else if (!player.onGround()) {
                state.setInput(Input.SNEAK, false);
            }
        }
        if (!forcedRotation) {
            Vec3 destCenterOffset = new Vec3(destCenter.x + 0.125 * avoid.getX(),
                    destCenter.y, destCenter.z + 0.125 * avoid.getZ());
            state.setTarget(new MovementState.MovementTarget(
                    AimGeometry.yawTo(eye, destCenterOffset),
                    AimGeometry.pitchTo(eye, destCenterOffset), false));
        }
        return state;
    }

    /** Unknown execution reads must not cancel a bucket required by the known route. */
    boolean willPlaceBucket() {
        return requiresWaterBucket;
    }

    /** Facing of the first ladder within 15 blocks below the feet, stopping at the first obstruction. */
    private Direction avoid() {
        return firstLadderBelow(player.level(), world, feet(player));
    }

    static Direction firstLadderBelow(BlockGetter probe, BlockGetter shapes, BlockPos feet) {
        for (int i = 0; i < 15; i++) {
            BlockPos pos = feet.below(i);
            BlockState state = probe.getBlockState(pos);
            if (state.getBlock() == Blocks.LADDER) {
                return state.getValue(LadderBlock.FACING);
            }
            // The permitted downward probe ends at the first physical obstruction.
            if (!state.getCollisionShape(shapes, pos).isEmpty()) {
                return null;
            }
        }
        return null;
    }

    /** Cancelable only before walking off the edge (or while preparing); mid-air momentum is irreversible. */
    @Override
    protected boolean safeToCancel(MovementState state) {
        return feet(player).equals(src) || state.getStatus() != MovementStatus.RUNNING;
    }

    /** Hotbar slot holding the given item (same item and components), or -1 if none. */
    private int hotbarSlotWith(Item item) {
        int slot = player.getInventory().findSlotMatchingItem(new net.minecraft.world.item.ItemStack(item));
        return net.minecraft.world.entity.player.Inventory.isHotbarSlot(slot) ? slot : -1;
    }

    /** The whole column at dest's XZ from the height of src.above() down to dest (diffY+2 tall). */
    private static BlockPos[] buildPositionsToBreak(BlockPos src, BlockPos dest) {
        int diffY = Math.abs(src.getY() - dest.getY());
        BlockPos[] toBreak = new BlockPos[diffY + 2];
        for (int i = 0; i < toBreak.length; i++) {
            toBreak[i] = new BlockPos(dest.getX(), src.getY() + 1 - i, dest.getZ());
        }
        return toBreak;
    }

    /** Generic mining only if one of the top four cells needs it; deeper cells (maybe water) are ignored. */
    @Override
    protected boolean prepared(MovementState state) {
        if (state.getStatus() == MovementStatus.WAITING) {
            return true;
        }
        for (int i = 0; i < 4 && i < positionsToBreak.length; i++) {
            if (!MovementHelper.canWalkThrough(world, positionsToBreak[i])) {
                return super.prepared(state);
            }
        }
        return true;
    }
}
