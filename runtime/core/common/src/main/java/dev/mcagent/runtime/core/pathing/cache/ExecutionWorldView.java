package dev.mcagent.runtime.core.pathing.cache;

import dev.mcagent.runtime.core.pathing.moves.ChunkLoadedTest;
import dev.mcagent.runtime.core.pathing.moves.MovementHelper;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;

import java.util.List;

/** One execution decision's knowledge, with the permitted twelve body-adjacent cells. */
public final class ExecutionWorldView implements BlockGetter {
    private final EmbodiedNavView knowledge;
    private final BlockGetter body;
    private final BlockPos feet;
    private final List<AABB> fallingBlocks;

    public ExecutionWorldView(EmbodiedNavView knowledge, BlockGetter body, BlockPos feet,
                              List<AABB> fallingBlocks) {
        this.knowledge = knowledge;
        this.body = body;
        this.feet = feet.immutable();
        this.fallingBlocks = List.copyOf(fallingBlocks);
    }

    public static boolean bodyAdjacent(BlockPos feet, BlockPos pos) {
        int horizontal = Math.abs(pos.getX() - feet.getX()) + Math.abs(pos.getZ() - feet.getZ());
        int dy = pos.getY() - feet.getY();
        return horizontal == 0 && dy >= -1 && dy <= 2
                || horizontal == 1 && dy >= 0 && dy <= 1;
    }

    @Override
    public BlockState getBlockState(BlockPos pos) {
        return bodyAdjacent(feet, pos) ? body.getBlockState(pos) : knowledge.getBlockState(pos);
    }

    /** Only for optional sprint joins along an already assembled path. */
    public boolean canWalkOnPlannedSupport(BlockPos pos) {
        // shortcut: unknown support preserves planned joins; use exact knowledge for new routes or actual footing.
        BlockState state = bodyAdjacent(feet, pos) || knowledge.isKnown(pos)
                ? getBlockState(pos) : Blocks.COBBLESTONE.defaultBlockState();
        return MovementHelper.canWalkOn(this, ChunkLoadedTest.ALWAYS,
                pos.getX(), pos.getY(), pos.getZ(), state);
    }

    public boolean hasFallingBlock(AABB area) {
        return fallingBlocks.stream().anyMatch(area::intersects);
    }

    @Override public FluidState getFluidState(BlockPos pos) { return getBlockState(pos).getFluidState(); }
    @Override public BlockEntity getBlockEntity(BlockPos pos) { return null; }
    @Override public int getHeight() { return knowledge.getHeight(); }
    @Override public int getMinBuildHeight() { return knowledge.getMinBuildHeight(); }
}
