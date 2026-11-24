package dev.mcagent.runtime.core.pathing.cache;

import dev.mcagent.runtime.core.pathing.moves.MovementHelper;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.evidence.BlockEvidenceStore;
import dev.mcagent.runtime.evidence.BlockObservation;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class ExecutionWorldViewTest {
    private static final String DIMENSION = "minecraft:overworld";
    private static final BlockPos FEET = new BlockPos(0, 64, 0);

    @BeforeAll
    static void bootstrap() {
        net.minecraft.SharedConstants.tryDetectVersion();
        net.minecraft.server.Bootstrap.bootStrap();
    }

    @Test
    void onlyTwelveCurrentBodyCellsMayReadTheServer() {
        Set<BlockPos> reads = new HashSet<>();
        BlockGetter live = live(reads, Blocks.STONE.defaultBlockState());
        var view = new ExecutionWorldView(knowledge(new BlockEvidenceStore()), live, FEET, List.of());
        for (BlockPos pos : BlockPos.betweenClosed(FEET.offset(-2, -2, -2), FEET.offset(2, 3, 2))) {
            view.getBlockState(pos);
        }
        Set<BlockPos> expected = new HashSet<>(List.of(FEET, FEET.above(), FEET.below(), FEET.above(2)));
        for (var direction : net.minecraft.core.Direction.Plane.HORIZONTAL) {
            expected.add(FEET.relative(direction));
            expected.add(FEET.relative(direction).above());
        }
        assertEquals(expected, reads);
        assertEquals(12, reads.size());

        reads.clear();
        var moved = new ExecutionWorldView(knowledge(new BlockEvidenceStore()), live, FEET.east(4), List.of());
        assertTrue(moved.getBlockState(FEET).isAir());
        assertTrue(reads.isEmpty(), "the old source cell is no longer a body exception");
    }

    @Test
    void hiddenTerrainCannotChangePredictiveRayOrKnownState() {
        BlockPos target = FEET.east(4);
        BlockEvidenceStore store = new BlockEvidenceStore();
        store.publishFrame(DIMENSION, 1, List.of(BlockObservation.of(target,
                Blocks.STONE.defaultBlockState(), BlockEvidenceSource.VISION)));
        Set<BlockPos> reads = new HashSet<>();
        for (BlockState hidden : List.of(Blocks.AIR.defaultBlockState(), Blocks.BEDROCK.defaultBlockState())) {
            var view = new ExecutionWorldView(knowledge(store), live(reads, hidden), FEET, List.of());
            Vec3 start = Vec3.atCenterOf(FEET.east(2));
            var hit = view.clip(new ClipContext(start, Vec3.atCenterOf(target),
                    ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, CollisionContext.empty()));
            assertEquals(net.minecraft.world.phys.HitResult.Type.BLOCK, hit.getType());
            assertEquals(target, hit.getBlockPos());
            assertTrue(view.getBlockState(FEET.east(3)).isAir());
            assertTrue(view.getBlockState(target).is(Blocks.STONE));
        }
        assertTrue(reads.isEmpty(), "predictive rays cannot query hidden live terrain");
    }

    @Test
    void plannedSupportAssumptionDoesNotCreateKnowledgeOrPlacementFaces() {
        var knowledge = knowledge(new BlockEvidenceStore());
        var view = new ExecutionWorldView(knowledge, live(new HashSet<>(), Blocks.AIR.defaultBlockState()),
                FEET, List.of());
        BlockPos unknown = FEET.east(4).below();
        assertTrue(view.canWalkOnPlannedSupport(unknown));
        assertTrue(view.getBlockState(unknown).isAir());
        assertFalse(MovementHelper.canPlaceAgainst(view, unknown));
        assertFalse(knowledge.isKnown(unknown));
        assertFalse(view.canWalkOnPlannedSupport(FEET.below()), "actual body support overrides the assumption");

        var store = new BlockEvidenceStore();
        store.publishFrame(DIMENSION, 1, List.of(BlockObservation.knownAir(unknown, BlockEvidenceSource.VISION)));
        var observedGap = new ExecutionWorldView(knowledge(store),
                live(new HashSet<>(), Blocks.STONE.defaultBlockState()), FEET, List.of());
        assertFalse(observedGap.canWalkOnPlannedSupport(unknown), "known air must not become assumed support");
    }

    @Test
    void waterSupportHelpersCannotExpandTheBodyExceptionIntoUndergroundNeighbors() {
        Set<BlockPos> reads = new HashSet<>();
        var view = new ExecutionWorldView(knowledge(new BlockEvidenceStore()),
                live(reads, Blocks.WATER.defaultBlockState()), FEET, List.of());
        MovementHelper.canWalkOn(view, FEET.below());
        assertEquals(Set.of(FEET.below(), FEET), reads);
    }

    @Test
    void fallingBlockWaitUsesOnlyCapturedBoxes() {
        AABB falling = new AABB(4, 64, 0, 5, 65, 1);
        var view = new ExecutionWorldView(knowledge(new BlockEvidenceStore()),
                live(new HashSet<>(), Blocks.AIR.defaultBlockState()), FEET, List.of(falling));
        assertTrue(view.hasFallingBlock(new AABB(4, 64, 0, 5, 65.1, 1)));
        assertFalse(view.hasFallingBlock(new AABB(8, 64, 0, 9, 65.1, 1)));
    }

    private static EmbodiedNavView knowledge(BlockEvidenceStore store) {
        return new EmbodiedNavView(store.snapshot(DIMENSION, FEET, 16), -64, 384);
    }

    private static BlockGetter live(Set<BlockPos> reads, BlockState state) {
        return new BlockGetter() {
            @Override public BlockState getBlockState(BlockPos pos) { reads.add(pos.immutable()); return state; }
            @Override public FluidState getFluidState(BlockPos pos) { return getBlockState(pos).getFluidState(); }
            @Override public BlockEntity getBlockEntity(BlockPos pos) { fail("unexpected block entity read"); return null; }
            @Override public int getHeight() { return 384; }
            @Override public int getMinBuildHeight() { return -64; }
        };
    }
}
