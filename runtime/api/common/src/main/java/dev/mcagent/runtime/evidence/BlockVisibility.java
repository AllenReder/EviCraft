package dev.mcagent.runtime.evidence;

import it.unimi.dsi.fastutil.objects.Reference2ByteOpenHashMap;
import it.unimi.dsi.fastutil.objects.Reference2ObjectOpenHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.ShulkerBoxBlock;
import net.minecraft.world.level.block.piston.MovingPistonBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.VoxelShape;

import java.util.List;

/**
 * How one block state meets a sight ray. Server-thread only.
 *
 * <p>{@link #AIR} lets the ray through and is remembered as air. {@link #OPAQUE} is a full cube
 * that ends every ray entering its cell. {@link #WATER} is a pure water cell, seen and passed.
 * {@link #COMPLEX} needs the exact outline shape and fluid surface of the cell.
 */
final class BlockVisibility {

    static final byte AIR = 0;
    static final byte OPAQUE = 1;
    static final byte WATER = 2;
    static final byte COMPLEX = 3;

    private static final byte UNCLASSIFIED = -1;
    private static final Reference2ByteOpenHashMap<BlockState> CLASSES = new Reference2ByteOpenHashMap<>();
    private static final Reference2ObjectOpenHashMap<BlockState, Outline> OUTLINES =
            new Reference2ObjectOpenHashMap<>();

    static {
        CLASSES.defaultReturnValue(UNCLASSIFIED);
    }

    private BlockVisibility() {}

    static byte classify(BlockState state) {
        byte known = CLASSES.getByte(state);
        if (known != UNCLASSIFIED) return known;
        byte computed = compute(state);
        CLASSES.put(state, computed);
        return computed;
    }

    /** Outline of a {@link #COMPLEX} state. */
    static Outline outline(BlockState state) {
        Outline known = OUTLINES.get(state);
        if (known != null) return known;
        Outline computed = Outline.of(state);
        OUTLINES.put(state, computed);
        return computed;
    }

    private static byte compute(BlockState state) {
        FluidState fluid = state.getFluidState();
        if (state.isAir() && fluid.isEmpty()) return AIR;
        if (fluid.isEmpty()) {
            Outline outline = outline(state);
            return outline.fullCube && !outline.transparent ? OPAQUE : COMPLEX;
        }
        return state.getBlock() instanceof LiquidBlock && VanillaVisibilityTransparency.fluid(fluid)
                ? WATER : COMPLEX;
    }

    /**
     * Outline boxes in cell-local coordinates. {@code live} outlines depend on more than the block
     * state and its position offset, so they are read from the level on every visit.
     */
    static final class Outline {
        final boolean transparent;
        final boolean live;
        final boolean offset;
        final boolean fullCube;
        final double[] boxes;

        private Outline(boolean transparent, boolean live, boolean offset, boolean fullCube,
                        double[] boxes) {
            this.transparent = transparent;
            this.live = live;
            this.offset = offset;
            this.fullCube = fullCube;
            this.boxes = boxes;
        }

        private static Outline of(BlockState state) {
            boolean transparent = VanillaVisibilityTransparency.block(state);
            Block block = state.getBlock();
            if (block instanceof ShulkerBoxBlock || block instanceof MovingPistonBlock) {
                return new Outline(transparent, true, false, false, new double[0]);
            }
            VoxelShape shape;
            Vec3 origin;
            try {
                shape = state.getShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO, CollisionContext.empty());
                origin = state.getOffset(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
            } catch (RuntimeException unreadable) {
                return new Outline(transparent, true, false, false, new double[0]);
            }
            boolean offset = state.hasOffsetFunction();
            List<AABB> parts = shape.toAabbs();
            double[] boxes = new double[parts.size() * 6];
            for (int index = 0; index < parts.size(); index++) {
                AABB part = parts.get(index);
                boxes[index * 6] = part.minX - origin.x;
                boxes[index * 6 + 1] = part.minY - origin.y;
                boxes[index * 6 + 2] = part.minZ - origin.z;
                boxes[index * 6 + 3] = part.maxX - origin.x;
                boxes[index * 6 + 4] = part.maxY - origin.y;
                boxes[index * 6 + 5] = part.maxZ - origin.z;
            }
            return new Outline(transparent, false, offset,
                    !offset && Block.isShapeFullBlock(shape), boxes);
        }
    }
}
