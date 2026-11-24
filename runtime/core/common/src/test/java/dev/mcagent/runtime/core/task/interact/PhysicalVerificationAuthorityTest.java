package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertIterableEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class PhysicalVerificationAuthorityTest {
    @BeforeAll
    static void bootMinecraftRegistries() {
        net.minecraft.SharedConstants.tryDetectVersion();
        net.minecraft.server.Bootstrap.bootStrap();
    }

    @Test
    void onePhysicalResultBecomesOneMultiFactAttributableUpdate() {
        BlockPos target = new BlockPos(2, 64, 3);
        var update = PhysicalVerificationAuthority.attributableUpdate(
                "minecraft:overworld", 42L, List.of(
                        new PhysicalVerificationAuthority.BlockOutcome(
                                target, Blocks.AIR.defaultBlockState(),
                                BlockEvidenceSource.ATTRIBUTABLE_ACTION),
                        new PhysicalVerificationAuthority.BlockOutcome(
                                target.east(), Blocks.STONE.defaultBlockState(),
                                BlockEvidenceSource.ATTRIBUTABLE_ACTION)));

        assertEquals(2, update.blocks().size());
        assertEquals(42L, update.blocks().getFirst().observedTick());
        assertEquals(42L, update.blocks().getLast().observedTick());
    }

    @Test
    void exactActionsCannotBindUnknownWorldKnowledge() {
        assertThrows(IllegalArgumentException.class, () ->
                new PhysicalVerificationAuthority.BoundBlock(
                        new BlockPos(2, 64, 3),
                dev.mcagent.runtime.evidence.BlockEvidenceCell.unknown()));
    }

    @Test
    void publicationKeepsOneRevisionBatchAndDoesNotAliasCallerList() {
        var outcomes = new java.util.ArrayList<>(List.of(
                new PhysicalVerificationAuthority.BlockOutcome(
                        new BlockPos(1, 2, 3), Blocks.STONE.defaultBlockState(),
                        BlockEvidenceSource.ATTRIBUTABLE_ACTION)));
        var update = PhysicalVerificationAuthority.attributableUpdate(
                "minecraft:overworld", 7L, outcomes);
        outcomes.clear();

        assertEquals(1, update.blocks().size());
        assertIterableEquals(List.of("minecraft:overworld"),
                update.blocks().stream().map(fact -> fact.dimension()).toList());
        assertEquals(7L, update.blocks().getFirst().observedTick());
    }

    @Test
    void failureCodesRemainStableOnTheWire() {
        assertEquals("target_changed",
                PhysicalVerificationAuthority.FailureCode.TARGET_CHANGED.wireValue());
        assertEquals("bed_not_usable_in_dimension",
                PhysicalVerificationAuthority.FailureCode.BED_NOT_USABLE.wireValue());
    }

    @Test
    void itemUseBatchesEveryChangedSampledCell() {
        BlockPos target = new BlockPos(2, 64, 3);
        BlockPos adjacent = target.east();

        var changed = PhysicalVerificationAuthority.changedItemUseBlocks(
                target, Blocks.STONE.defaultBlockState(), Blocks.DIRT.defaultBlockState(),
                adjacent, Blocks.AIR.defaultBlockState(), Blocks.FIRE.defaultBlockState());

        assertEquals(List.of(target, adjacent), changed.stream()
                .map(PhysicalVerificationAuthority.BlockOutcome::position).toList());
    }

    @Test
    void entityOutcomeBatchesObservationAndRemovalAtOneRevision() {
        UUID uuid = UUID.randomUUID();
        var observation = dev.mcagent.runtime.evidence.EntityObservation.attributable(
                uuid, "minecraft:item", "minecraft:diamond", 1,
                new net.minecraft.world.phys.Vec3(1, 2, 3), null, null);
        var update = PhysicalVerificationAuthority.attributableEntityUpdate(
                "minecraft:overworld", 9L, List.of(observation), List.of(uuid));
        assertEquals(1, update.entities().size());
        assertEquals(List.of(uuid), update.removedEntities());
        assertEquals(9L, update.entities().getFirst().observedTick());
    }
}
