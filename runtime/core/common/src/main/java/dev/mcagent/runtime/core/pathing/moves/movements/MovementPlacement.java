package dev.mcagent.runtime.core.pathing.moves.movements;
import dev.mcagent.runtime.core.pathing.settings.ScaffoldMaterials;
import dev.mcagent.runtime.core.pathing.moves.AimGeometry;

import java.util.List;

import dev.mcagent.runtime.core.pathing.moves.Input;
import dev.mcagent.runtime.core.pathing.moves.MovementHelper;
import dev.mcagent.runtime.core.pathing.moves.MovementState;
import dev.mcagent.runtime.core.pathing.moves.MovementStatus;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.Holder;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.item.enchantment.Enchantments;
import net.minecraft.world.item.enchantment.ItemEnchantments;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Placement and line-of-sight logic shared by movement primitives at execution time: five-face enumeration,
 * face-center aim points, rotation-rate-limited hit prediction, scaffolding selection, and view hit tests.
 *
 * <p>Rotation uses AimProcessor to convert the ideal target rotation into "where the head can actually turn
 * this tick" (bounded by mouse pixel quantization and the rotation rate limit) before raytracing. Placement
 * candidates that need a large single-tick turn (such as Pillar looking down at the feet mid-air, or Parkour
 * switching to look at dest.below) may be judged "out of reach this tick" and deferred to the next tick or
 * a different face. When the block center is not visible, fall back to raytracing the six face centers of
 * the block's outline shape (edge fallback).
 */
final class MovementPlacement {

    private MovementPlacement() {}

    /** Outcome of one placement attempt. */
    enum PlaceResult {
        /** The view is on the correct face; right-click this tick. */
        READY_TO_PLACE,
        /** A feasible face was found and its rotation written into state; waiting for the head to turn. */
        ATTEMPTING,
        /** None of the five faces is feasible. */
        NO_OPTION
    }

    /** Placement face enumeration order: the four horizontal directions first, DOWN last (no UP). */
    static final Direction[] HORIZONTALS_AND_DOWN = {
            Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.DOWN
    };

    /** Eye height while sneaking (meters). */
    private static final double SNEAK_EYE_HEIGHT = 1.27;

    /**
     * Rotation quantizer with the same sensitivity as ExecHarness (0.5). Converts the ideal rotation of a
     * placement candidate into "where the head can actually turn this tick" before raytracing. A single
     * instance suffices: pure math, stateless.
     */
    private static final dev.mcagent.runtime.core.pathing.execute.AimProcessor AIM =
            new dev.mcagent.runtime.core.pathing.execute.AimProcessor();

    /** Shape-point factors for the placement fallback (block center first, then the six face centers). */
    private static final double[][] FACE_OFFSETS = {
            {0.5, 0.5, 0.5}, // center
            {0.5, 0.0, 0.5}, // up
            {0.5, 1.0, 0.5}, // down
            {0.5, 0.5, 0.0}, // south
            {0.5, 0.5, 1.0}, // north
            {0.0, 0.5, 0.5}, // east
            {1.0, 0.5, 0.5}  // west
    };

    /** Convenience entry that uses the player's current view as the current rotation. */
    static PlaceResult attemptToPlaceABlock(MovementState state, ServerPlayer player,
                                            BlockGetter level, BlockPos placeAt, boolean preferDown, boolean wouldSneak) {
        return attemptToPlaceABlock(state, player, level, placeAt, preferDown, wouldSneak,
                player.getYRot(), player.getXRot());
    }

    /**
     * Try to find a feasible placement face for placeAt. First try looking at placeAt itself (a replaceable
     * block with its own outline can be hit; if its center is not visible, fall back to the six face
     * centers), then enumerate the five faces in {@link #HORIZONTALS_AND_DOWN}. A face qualifies if its block
     * can be placed against, and the ray along "where the head can actually turn this tick" hits that block
     * with the neighbor of the hit face being exactly placeAt. preferDown=false takes the first feasible face
     * (horizontal first); true takes the last (DOWN first, so mid-air placement needs no head tilt).
     *
     * <p>Current rotation already hits the correct target: READY_TO_PLACE (the caller presses right-click).
     * Face found but not yet aimed: ATTEMPTING. None found: NO_OPTION.
     * Without scaffolding blocks, sets UNREACHABLE and returns NO_OPTION.
     */
    static PlaceResult attemptToPlaceABlock(MovementState state, ServerPlayer player,
                                            BlockGetter level, BlockPos placeAt, boolean preferDown, boolean wouldSneak,
                                            float currentYaw, float currentPitch) {
        double reach = NavSettings.get().blockReachDistance;
        Vec3 eye = eyePosition(player, wouldSneak);
        boolean found = false;
        BlockHitResult foundHit = null;
        float foundYaw = currentYaw;
        float foundPitch = currentPitch;

        // Look at placeAt itself (actual replaceability is verified by the physical placement). If the
        // center is not visible, fall back to the outline's six face centers, raytracing with the peeked
        // rotation.
        for (double[] off : FACE_OFFSETS) {
            Vec3 aim = shapePoint(level, placeAt, off[0], off[1], off[2]);
            float yaw = AimGeometry.yawTo(eye, aim);
            float pitch = AimGeometry.pitchTo(eye, aim);
            dev.mcagent.runtime.core.pathing.execute.AimProcessor.Rotation peek =
                    AIM.step(currentYaw, currentPitch, yaw, pitch);
            BlockHitResult hit = rayTrace(player, level, eye, peek.yaw(), peek.pitch(), reach);
            if (hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(placeAt)) {
                if (!selectForLocation(player, placeAt, hit, peek.yaw(), peek.pitch(), false)) {
                    state.setStatus(MovementStatus.UNREACHABLE);
                    return PlaceResult.NO_OPTION;
                }
                state.setTarget(new MovementState.MovementTarget(yaw, pitch, true));
                found = true;
                foundHit = hit;
                foundYaw = peek.yaw();
                foundPitch = peek.pitch();
                break; // the block itself: take the first feasible point; preferDown does not apply
            }
        }

        for (int i = 0; i < 5; i++) {
            BlockPos against = placeAt.relative(HORIZONTALS_AND_DOWN[i]);
            if (!MovementHelper.canPlaceAgainst(level, against)) {
                continue;
            }
            // Face center: midpoint of the two cells, on their shared face
            double faceX = (placeAt.getX() + against.getX() + 1.0) * 0.5;
            double faceY = (placeAt.getY() + against.getY() + 0.5) * 0.5;
            double faceZ = (placeAt.getZ() + against.getZ() + 1.0) * 0.5;
            Vec3 face = new Vec3(faceX, faceY, faceZ);
            float yaw = AimGeometry.yawTo(eye, face);
            float pitch = AimGeometry.pitchTo(eye, face);
            // Rotation-rate limit: convert the ideal rotation into this tick's reachable one, then raytrace
            dev.mcagent.runtime.core.pathing.execute.AimProcessor.Rotation peek =
                    AIM.step(currentYaw, currentPitch, yaw, pitch);
            BlockHitResult hit = rayTrace(player, level, eye, peek.yaw(), peek.pitch(), reach);
            if (hit.getType() == HitResult.Type.BLOCK
                    && hit.getBlockPos().equals(against)
                    && hit.getBlockPos().relative(hit.getDirection()).equals(placeAt)) {
                if (!selectForLocation(player, placeAt, hit, peek.yaw(), peek.pitch(), false)) {
                    state.setStatus(MovementStatus.UNREACHABLE);
                    return PlaceResult.NO_OPTION;
                }
                state.setTarget(new MovementState.MovementTarget(yaw, pitch, true));
                found = true;
                foundHit = hit;
                foundYaw = peek.yaw();
                foundPitch = peek.pitch();
                if (!preferDown) {
                    break; // horizontal first: take the first feasible face
                }
            }
        }

        // Current rotation already hits the correct target: ready
        BlockHitResult looking = rayTrace(player, level, eyePosition(player, wouldSneak), currentYaw, currentPitch, reach);
        if (looking.getType() == HitResult.Type.BLOCK) {
            BlockPos selected = looking.getBlockPos();
            if (selected.equals(placeAt)
                    || (MovementHelper.canPlaceAgainst(level, selected)
                            && selected.relative(looking.getDirection()).equals(placeAt))) {
                if (wouldSneak) {
                    state.setInput(Input.SNEAK, true);
                }
                if (!selectForLocation(player, placeAt, looking, currentYaw, currentPitch, true)) {
                    state.setStatus(MovementStatus.UNREACHABLE);
                    return PlaceResult.NO_OPTION;
                }
                return PlaceResult.READY_TO_PLACE;
            }
        }
        if (found) {
            if (wouldSneak) {
                state.setInput(Input.SNEAK, true);
            }
            selectForLocation(player, placeAt, foundHit, foundYaw, foundPitch, true);
            return PlaceResult.ATTEMPTING;
        }
        return PlaceResult.NO_OPTION;
    }

    // Runtime route placement selects only the common scaffold-material policy.
    static boolean selectForLocation(ServerPlayer player, BlockPos placeAt, boolean select) {
        return selectThrowaway(player, select);
    }

    static boolean selectForLocation(ServerPlayer player, BlockPos placeAt, BlockHitResult hit,
                                     float yaw, float pitch, boolean select) {
        return selectThrowaway(player, select);
    }
    /** Whether the whole inventory + offhand holds any scaffolding block (checked before restocking). */
    private static boolean hasAnyThrowaway(ServerPlayer player, List<Item> acceptable) {
        Inventory inv = player.getInventory();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack s = inv.getItem(i);
            if (!s.isEmpty() && acceptable.contains(s.getItem())) {
                return true;
            }
        }
        ItemStack off = player.getOffhandItem();
        return !off.isEmpty() && acceptable.contains(off.getItem());
    }

    /** Point on the block's outline shape at ratio (mx,my,mz); an empty shape falls back to a full block. */
    private static Vec3 shapePoint(BlockGetter level, BlockPos pos, double mx, double my, double mz) {
        net.minecraft.world.phys.shapes.VoxelShape shape = level.getBlockState(pos).getShape(level, pos);
        if (shape.isEmpty()) {
            shape = net.minecraft.world.phys.shapes.Shapes.block();
        }
        double x = shape.min(Direction.Axis.X) * mx + shape.max(Direction.Axis.X) * (1 - mx);
        double y = shape.min(Direction.Axis.Y) * my + shape.max(Direction.Axis.Y) * (1 - my);
        double z = shape.min(Direction.Axis.Z) * mz + shape.max(Direction.Axis.Z) * (1 - mz);
        return new Vec3(pos.getX() + x, pos.getY() + y, pos.getZ() + z);
    }

    /**
     * Find a scaffolding block and optionally switch to its slot. The outer loop walks item kinds in the
     * configured priority order of NavSettings.acceptableThrowawayItems (default dirt/cobblestone/netherrack/
     * stone); the inner loop scans hotbar 0-8 for that kind. If the hotbar has no match, check the offhand
     * unconditionally; on a match, select a harmless main-hand slot (empty or a tool) so right-click goes to
     * the offhand.
     *
     * <p>With {@code select=true} the chosen block is put in hand: a hotbar match selects that slot; an
     * offhand match switches the main hand to a slot with no right-click use (empty, or a mining tool with
     * the TOOL component: pickaxe/axe/shovel/hoe, which do not place blocks on right-click), so vanilla
     * places from the offhand on right-click.
     */
    static boolean selectThrowaway(ServerPlayer player, boolean select) {
        List<Item> acceptable = ScaffoldMaterials.of(player);
        Inventory inventory = player.getInventory();
        boolean allowInventory = NavSettings.get().allowInventory;
        // The free-materials profile's "reach into the creative inventory": with no scaffolding block at all,
        // add a stack of dirt. A vanilla creative player must also hold a block to place it; a human takes
        // it from the creative menu, which a fake player does not have, so this code does it. Survival
        // profiles never enter this branch.
        if (player.hasInfiniteMaterials() && !hasAnyThrowaway(player, acceptable)) {
            ItemStack restock = new ItemStack(net.minecraft.world.item.Items.DIRT, 64);
            if (!inventory.add(restock)) {
                return false;   // inventory full and no scaffolding: rare, treated as having none
            }
            dev.mcagent.runtime.core.Constants.LOG.debug(
                    "[mc_agent-place] infinite-materials profile auto-restocked scaffolding dirt ×64");
        }
        for (Item item : acceptable) {
            for (int i = 0; i < 9; i++) {
                ItemStack stack = inventory.getItem(i);
                if (!stack.isEmpty() && stack.getItem() == item) {
                    if (select) {
                        inventory.selected = i;
                    }
                    return true;
                }
            }
            // No hotbar match for this kind: check the offhand
            ItemStack offhand = player.getOffhandItem();
            if (!offhand.isEmpty() && offhand.getItem() == item) {
                // The main hand must not hold an item with a right-click use (blocks/buckets etc.), or
                // right-click goes to the main hand instead of the offhand. Pick an empty slot or a mining
                // tool with the TOOL component (pickaxe/axe/shovel/hoe), which do not place blocks on
                // right-click, so vanilla places from the offhand.
                for (int i = 0; i < 9; i++) {
                    ItemStack stack = inventory.getItem(i);
                    if (stack.isEmpty()
                            || stack.getItem().components().has(net.minecraft.core.component.DataComponents.TOOL)) {
                        if (select) {
                            inventory.selected = i;
                        }
                        return true;
                    }
                }
            }
            // Main inventory: used only with allowInventory; swap the stack into slot 7 and select it
            if (allowInventory) {
                for (int i = 9; i < 36; i++) {
                    ItemStack stack = inventory.getItem(i);
                    if (!stack.isEmpty() && stack.getItem() == item) {
                        if (select) {
                            ItemStack tmp = inventory.getItem(7);
                            inventory.setItem(7, stack);
                            inventory.setItem(i, tmp);
                            inventory.selected = 7;
                        }
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /** Whether the player's current view hits this block (outline ray, ignoring fluids). */
    static boolean isLookingAt(ServerPlayer player, BlockPos pos) {
        BlockHitResult hit = rayTrace(player, player.level(), player.getEyePosition(),
                player.getYRot(), player.getXRot(), NavSettings.get().blockReachDistance);
        return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(pos);
    }

    /** Whether the player's current rotation matches the target rotation in state (tolerance 0.01 degrees). */
    static boolean isFacing(ServerPlayer player, MovementState.MovementTarget target) {
        if (!target.hasRotation()) {
            return false;
        }
        return Math.abs(normalizeDegrees(player.getYRot() - target.getYaw())) < 0.01
                && Math.abs(player.getXRot() - target.getPitch()) < 0.01;
    }

    /** Normalize an angle to [-180, 180). */
    static float normalizeDegrees(float degrees) {
        float wrapped = degrees % 360.0f;
        if (wrapped < -180.0f) {
            wrapped += 360.0f;
        }
        if (wrapped >= 180.0f) {
            wrapped -= 360.0f;
        }
        return wrapped;
    }

    /** Execution-time Frost Walker check: Frost Walker is equipped and the cell is a still water source. */
    static boolean canUseFrostWalker(ServerPlayer player, BlockState state) {
        return frostWalkerLevel(player) != 0
                && state.getBlock() == Blocks.WATER
                && state.getValue(LiquidBlock.LEVEL) == 0;
    }

    /** Highest Frost Walker level across all equipment. */
    static int frostWalkerLevel(ServerPlayer player) {
        int level = 0;
        for (EquipmentSlot slot : EquipmentSlot.values()) {
            ItemEnchantments itemEnchantments = player.getItemBySlot(slot).getEnchantments();
            for (Holder<Enchantment> enchant : itemEnchantments.keySet()) {
                if (enchant.is(Enchantments.FROST_WALKER)) {
                    level = Math.max(level, itemEnchantments.getLevel(enchant));
                }
            }
        }
        return level;
    }

    /** Outline ray from eye along the given rotation (fluids excluded). */
    static BlockHitResult rayTrace(ServerPlayer player, BlockGetter level, Vec3 eye, float yaw, float pitch, double reach) {
        Vec3 end = eye.add(direction(yaw, pitch).scale(reach));
        return level.clip(new ClipContext(eye, end,
                ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
    }

    /** Rotation -> unit view vector. */
    static Vec3 direction(float yaw, float pitch) {
        double yawRad = Math.toRadians(yaw);
        double pitchRad = Math.toRadians(pitch);
        double cosPitch = Math.cos(pitchRad);
        return new Vec3(-Math.sin(yawRad) * cosPitch, -Math.sin(pitchRad), Math.cos(yawRad) * cosPitch);
    }

    /** Eye position; with wouldSneak, the sneaking eye height (faces computed from the placement-time view). */
    static Vec3 eyePosition(ServerPlayer player, boolean wouldSneak) {
        if (wouldSneak) {
            return new Vec3(player.getX(), player.getY() + SNEAK_EYE_HEIGHT, player.getZ());
        }
        return player.getEyePosition();
    }
}
