package dev.mcagent.runtime.core.pathing.cache;

import dev.mcagent.runtime.evidence.BlockEvidenceStore;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.evidence.BlockObservation;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class EmbodiedNavViewTest {

    private static final String OVERWORLD = "minecraft:overworld";

    @BeforeAll
    static void bootMinecraftRegistries() {
        net.minecraft.SharedConstants.tryDetectVersion();
        net.minecraft.server.Bootstrap.bootStrap();
    }

    @Test
    void unknownIsOptimisticAirButMarksTheMovementDependencySpeculative() {
        BlockEvidenceStore store = new BlockEvidenceStore();
        EmbodiedNavView view = new EmbodiedNavView(
                store.snapshot(OVERWORLD, BlockPos.ZERO, 16), -64, 384);
        view.beginDependencyCapture();

        assertTrue(view.getBlockState(new BlockPos(8, 70, 9)).isAir());
        assertTrue(view.dependencyWasUnknown());
        assertFalse(view.isKnownBlock(new BlockPos(8, 70, 9)));
    }

    @Test
    void knownBlockPropertiesSurviveIntoTheNavigationView() {
        BlockPos door = new BlockPos(2, 64, 3);
        BlockEvidenceStore store = new BlockEvidenceStore();
        store.publishFrame(OVERWORLD, 40L, java.util.List.of(
                BlockObservation.of(door, net.minecraft.world.level.block.Blocks.OAK_DOOR
                        .defaultBlockState().setValue(BlockStateProperties.OPEN, true),
                        BlockEvidenceSource.VISION)));
        EmbodiedNavView view = new EmbodiedNavView(
                store.snapshot(OVERWORLD, door, 16), -64, 384);
        view.beginDependencyCapture();

        var state = view.getBlockState(door);

        assertTrue(state.getBlock() instanceof DoorBlock);
        assertTrue(state.getValue(BlockStateProperties.OPEN));
        assertFalse(view.dependencyWasUnknown());
        assertTrue(view.isKnownBlock(door));
    }
}
