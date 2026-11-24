package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.entity.BotPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.VoxelShape;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Shared physical policy for verified block interaction intents. */
public final class VerifiedBlockInteraction {
    private static final List<Direction> FACE_ORDER = List.of(
            Direction.DOWN, Direction.UP, Direction.NORTH,
            Direction.SOUTH, Direction.WEST, Direction.EAST);

    /** Ticks a pose search waits for the body to come to rest before it gives up on a resolved probe. */
    static final int SETTLE_TICKS = 20;

    private VerifiedBlockInteraction() {}

    /**
     * Supported, on the ground or floating at a water surface, with no horizontal drift, so the
     * rays probed now are the rays the next action casts.
     */
    static boolean bodySettled(BotPlayer player) {
        Vec3 motion = player.getDeltaMovement();
        return (player.onGround() || player.isInWater())
                // Even a sub-centimeter step can move a grazing ray onto an occluder.
                // Let native deceleration finish before handing the pose to another action.
                && motion.x == 0.0 && motion.z == 0.0;
    }

    static List<Direction> orderedFaces() {
        return FACE_ORDER;
    }

    static Vec3 faceCenter(BlockPos block, Direction face) {
        return Vec3.atCenterOf(block).add(
                face.getStepX() * 0.5, face.getStepY() * 0.5, face.getStepZ() * 0.5);
    }

    static int faceRank(Direction face) {
        return FACE_ORDER.indexOf(face);
    }

    /**
     * Bucket pickup must resolve source fluid surfaces as well as ordinary block outlines.
     * Aim points sit just inside the target's real outline, or its fluid surface when the
     * ray admits fluids, and each ray runs the full native reach like the player's view ray.
     */
    private static BlockHitResult resolveDirectHit(BotPlayer player, BlockPos target, ClipContext.Fluid fluids) {
        Vec3 eye = player.getEyePosition();
        double reach = player.blockInteractionRange();
        List<BlockHitResult> candidates = new ArrayList<>();
        for (Vec3 aim : aimPoints(player, target, fluids)) {
            BlockHitResult clipped = nativeRay(player, eye, aim, reach, fluids);
            if (clipped != null && clipped.getBlockPos().equals(target)) {
                // A ray aimed at a face can enter through another face.
                // Dispatch the native hit, not the face we originally aimed toward.
                candidates.add(clipped);
            }
        }
        return closest(eye, candidates);
    }

    /**
     * A full bucket empties into the cell beside the clicked face. A fluid target has no
     * outline to click, so click the face of a neighboring block that faces the target, as a
     * player pours water onto lava; an ordinary target is clicked directly.
     */
    static BlockHitResult resolveBucketHit(BotPlayer player, BlockPos target, Item bucket) {
        ClipContext.Fluid fluids = bucketRayFluids(bucket);
        BlockHitResult direct = resolveDirectHit(player, target, fluids);
        if (direct != null || fluids != ClipContext.Fluid.NONE) return direct;
        BlockState state = player.level().getBlockState(target);
        if (!state.liquid() && !state.isAir()) return null;
        Vec3 eye = player.getEyePosition();
        double reach = player.blockInteractionRange();
        List<BlockHitResult> candidates = new ArrayList<>();
        for (Direction side : orderedFaces()) {
            BlockPos neighbor = target.relative(side);
            Direction face = side.getOpposite();
            VoxelShape outline = player.level().getBlockState(neighbor)
                    .getShape(player.level(), neighbor, CollisionContext.of(player));
            if (outline.isEmpty()) continue;
            for (AABB local : outline.toAabbs()) {
                Vec3 aim = insetFaceCenter(local.move(neighbor), face);
                BlockHitResult clipped = nativeRay(player, eye, aim, reach, fluids);
                if (clipped != null && clipped.getBlockPos().equals(neighbor)
                        && clipped.getDirection() == face) {
                    candidates.add(clipped);
                }
            }
        }
        return closest(eye, candidates);
    }

    /**
     * An empty bucket aimed at a cell it can never pick up from: no fluid source there, and not
     * a cauldron or powder snow, which empty buckets also take from.
     */
    static boolean emptyBucketWithoutSource(BotPlayer player, BlockPos target, Item bucket) {
        if (bucket != Items.BUCKET) return false;
        BlockState state = player.level().getBlockState(target);
        if (state.getBlock() instanceof net.minecraft.world.level.block.AbstractCauldronBlock
                || state.getBlock() instanceof net.minecraft.world.level.block.PowderSnowBlock) {
            return false;
        }
        FluidState fluid = player.level().getFluidState(target);
        return fluid.isEmpty() || !fluid.isSource();
    }

    /** Why {@link #resolveBucketHit} found no hit, so the caller can say what would fix it. */
    enum BucketMissKind { NOT_FLUID_SOURCE, NO_SUPPORT_FACE, OUT_OF_REACH, OCCLUDED }

    record BucketMiss(BucketMissKind kind, BlockPos blocker, BlockState blockerState) {}

    /**
     * Classify a target for which {@link #resolveBucketHit} returned null. An empty bucket only
     * picks up a source; a full bucket targeting a fluid or air cell needs a neighbouring block
     * face; otherwise the aim points are either all beyond reach or behind the first native hit.
     */
    static BucketMiss explainBucketMiss(BotPlayer player, BlockPos target, Item bucket) {
        ClipContext.Fluid fluids = bucketRayFluids(bucket);
        BlockState state = player.level().getBlockState(target);
        List<Vec3> aims = new ArrayList<>(aimPoints(player, target, fluids));
        if (emptyBucketWithoutSource(player, target, bucket)) {
            return new BucketMiss(BucketMissKind.NOT_FLUID_SOURCE, null, null);
        }
        if (aims.isEmpty() && fluids == ClipContext.Fluid.NONE && (state.liquid() || state.isAir())) {
            for (Direction side : orderedFaces()) {
                BlockPos neighbor = target.relative(side);
                VoxelShape outline = player.level().getBlockState(neighbor)
                        .getShape(player.level(), neighbor, CollisionContext.of(player));
                for (AABB local : outline.toAabbs()) {
                    aims.add(insetFaceCenter(local.move(neighbor), side.getOpposite()));
                }
            }
            if (aims.isEmpty()) return new BucketMiss(BucketMissKind.NO_SUPPORT_FACE, null, null);
        }
        Vec3 eye = player.getEyePosition();
        double reach = player.blockInteractionRange();
        Vec3 nearest = aims.stream()
                .filter(aim -> eye.distanceToSqr(aim) <= reach * reach)
                .min(Comparator.comparingDouble(eye::distanceToSqr))
                .orElse(null);
        if (nearest == null) return new BucketMiss(BucketMissKind.OUT_OF_REACH, null, null);
        BlockHitResult first = nativeRay(player, eye, nearest, reach, fluids);
        BlockPos blocker = first == null ? null : first.getBlockPos();
        return new BucketMiss(BucketMissKind.OCCLUDED, blocker,
                blocker == null ? null : player.level().getBlockState(blocker));
    }

    /** BucketItem's own view ray: an empty bucket stops on source fluids, a full one passes through fluids. */
    static ClipContext.Fluid bucketRayFluids(Item bucket) {
        return bucket == Items.BUCKET ? ClipContext.Fluid.SOURCE_ONLY : ClipContext.Fluid.NONE;
    }

    private static List<Vec3> aimPoints(BotPlayer player, BlockPos target, ClipContext.Fluid fluids) {
        VoxelShape shape = player.level().getBlockState(target)
                .getShape(player.level(), target, CollisionContext.of(player));
        if (fluids != ClipContext.Fluid.NONE) {
            FluidState fluid = player.level().getFluidState(target);
            if (!fluid.isEmpty()) shape = fluid.getShape(player.level(), target);
        }
        List<Vec3> points = new ArrayList<>();
        if (shape.isEmpty()) return points;
        for (AABB local : shape.toAabbs()) {
            AABB box = local.move(target);
            for (Direction face : orderedFaces()) points.add(insetFaceCenter(box, face));
        }
        return points;
    }

    private static Vec3 insetFaceCenter(AABB box, Direction face) {
        Vec3 center = box.getCenter();
        double inset = 1.0E-2;
        return switch (face.getAxis()) {
            case X -> new Vec3(face.getStepX() > 0 ? box.maxX - inset : box.minX + inset, center.y, center.z);
            case Y -> new Vec3(center.x, face.getStepY() > 0 ? box.maxY - inset : box.minY + inset, center.z);
            case Z -> new Vec3(center.x, center.y, face.getStepZ() > 0 ? box.maxZ - inset : box.minZ + inset);
        };
    }

    private static BlockHitResult nativeRay(
            BotPlayer player, Vec3 eye, Vec3 aim, double reach, ClipContext.Fluid fluids) {
        if (eye.distanceToSqr(aim) > reach * reach) return null;
        Vec3 direction = aim.subtract(eye);
        if (direction.lengthSqr() < 1.0E-9) return null;
        BlockHitResult clipped = player.level().clip(new ClipContext(eye,
                eye.add(direction.normalize().scale(reach)), ClipContext.Block.OUTLINE, fluids, player));
        return clipped.getType() == HitResult.Type.BLOCK ? clipped : null;
    }

    private static BlockHitResult closest(Vec3 eye, List<BlockHitResult> candidates) {
        return candidates.stream()
                .min(Comparator.comparingDouble((BlockHitResult hit) ->
                                eye.distanceToSqr(hit.getLocation()))
                        .thenComparingInt(hit -> faceRank(hit.getDirection())))
                .orElse(null);
    }

    /** Temporary empty main-hand ownership that restores selected slot and held stack. */
    public static final class NeutralMainHandLease implements AutoCloseable {
        private final BotPlayer player;
        private final int selected;
        private final boolean sneaking;
        private final ItemStack held;
        private boolean closed;

        public NeutralMainHandLease(BotPlayer player) {
            this.player = player;
            Inventory inventory = player.getInventory();
            this.selected = inventory.selected;
            this.sneaking = player.isShiftKeyDown();
            this.held = inventory.getItem(selected);
            inventory.setItem(selected, ItemStack.EMPTY);
            player.setShiftKeyDown(false);
        }

        @Override
        public void close() {
            if (closed) return;
            closed = true;
            Inventory inventory = player.getInventory();
            if (!inventory.getItem(selected).isEmpty()) {
                throw new IllegalStateException("neutral main hand was unexpectedly mutated");
            }
            inventory.setItem(selected, held);
            inventory.selected = selected;
            player.setShiftKeyDown(sneaking);
            inventory.setChanged();
        }
    }

    /**
     * Temporarily swaps one exact carried item into the selected main-hand slot. Any real
     * consumption, durability, or identity mutation follows that stack back to its original
     * logical slot when the lease closes; the displaced selected stack and sneak state are restored.
     */
    public static final class ExactMainHandLease implements AutoCloseable {
        private final BotPlayer player;
        private final int selected;
        private final int source;
        private final boolean sneaking;
        private final ItemStack displaced;
        private final ItemStack displacedSnapshot;
        private final ItemStack before;
        private boolean closed;

        public ExactMainHandLease(BotPlayer player, Item item, boolean secondaryUse) {
            this.player = player;
            Inventory inventory = player.getInventory();
            this.selected = inventory.selected;
            this.source = dev.mcagent.runtime.core.PlayerInv.findSlot(inventory, item);
            if (source < 0) throw new IllegalStateException("requested item is not carried");
            this.sneaking = player.isShiftKeyDown();
            this.before = inventory.getItem(source).copy();
            if (source == selected) {
                this.displaced = ItemStack.EMPTY;
                this.displacedSnapshot = ItemStack.EMPTY;
            } else {
                this.displaced = inventory.getItem(selected);
                this.displacedSnapshot = displaced.copy();
                ItemStack requested = inventory.getItem(source);
                inventory.setItem(source, displaced);
                inventory.setItem(selected, requested);
            }
            player.setShiftKeyDown(secondaryUse);
            inventory.setChanged();
        }

        public ItemStack before() {
            return before.copy();
        }

        public ItemStack current() {
            return player.getInventory().getItem(selected).copy();
        }

        @Override
        public void close() {
            if (closed) return;
            closed = true;
            Inventory inventory = player.getInventory();
            if (source != selected) {
                if (!ItemStack.matches(inventory.getItem(source), displacedSnapshot)) {
                    throw new IllegalStateException("parked selected stack was unexpectedly mutated");
                }
                ItemStack resulting = inventory.getItem(selected);
                inventory.setItem(source, resulting);
                inventory.setItem(selected, displaced);
            }
            inventory.selected = selected;
            player.setShiftKeyDown(sneaking);
            inventory.setChanged();
        }
    }
}
