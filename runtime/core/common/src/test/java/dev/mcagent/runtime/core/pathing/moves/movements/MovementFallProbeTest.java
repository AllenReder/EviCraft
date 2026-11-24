package dev.mcagent.runtime.core.pathing.moves.movements;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LadderBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class MovementFallProbeTest {
    private static final BlockPos FEET = new BlockPos(0, 64, 0);

    @BeforeAll
    static void bootstrap() {
        net.minecraft.SharedConstants.tryDetectVersion();
        net.minecraft.server.Bootstrap.bootStrap();
    }

    @Test
    void solidOrPartialCollisionStopsBeforeHiddenLadder() {
        for (BlockState obstruction : List.of(Blocks.STONE.defaultBlockState(), Blocks.OAK_SLAB.defaultBlockState())) {
            List<BlockPos> reads = new ArrayList<>();
            BlockGetter probe = column(reads, obstruction);
            assertNull(MovementFall.firstLadderBelow(probe, probe, FEET));
            assertEquals(List.of(FEET, FEET.below(), FEET.below(2)), reads);
        }
    }

    @Test
    void clearColumnReachesTheFirstLadder() {
        List<BlockPos> reads = new ArrayList<>();
        BlockGetter probe = column(reads, Blocks.AIR.defaultBlockState());
        assertEquals(Direction.EAST, MovementFall.firstLadderBelow(probe, probe, FEET));
        assertEquals(FEET.below(3), reads.getLast());
    }

    private static BlockGetter column(List<BlockPos> reads, BlockState obstruction) {
        return new BlockGetter() {
            @Override public BlockState getBlockState(BlockPos pos) {
                reads.add(pos.immutable());
                if (pos.equals(FEET.below(2))) return obstruction;
                if (pos.equals(FEET.below(3))) {
                    return Blocks.LADDER.defaultBlockState().setValue(LadderBlock.FACING, Direction.EAST);
                }
                return Blocks.AIR.defaultBlockState();
            }
            @Override public FluidState getFluidState(BlockPos pos) { return getBlockState(pos).getFluidState(); }
            @Override public BlockEntity getBlockEntity(BlockPos pos) { return null; }
            @Override public int getHeight() { return 384; }
            @Override public int getMinBuildHeight() { return -64; }
        };
    }
}
