package dev.mcagent.runtime.core.task.interact;

import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;

class GotoBlockPlacementPoseTaskTest {

    @Test
    void placementNavigationProtectsTheTargetAndEveryKnownSupport() {
        BlockPos target = new BlockPos(7, 70, -12);
        BlockPos below = target.below();
        BlockPos east = target.east();

        Set<BlockPos> protectedPositions =
                GotoBlockPlacementPoseTask.placementNavigationProtection(
                        target, List.of(below, east, below));

        assertEquals(Set.of(target, below, east), protectedPositions);
    }
}
