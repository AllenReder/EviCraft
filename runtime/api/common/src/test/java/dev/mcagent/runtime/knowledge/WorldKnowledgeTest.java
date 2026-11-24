package dev.mcagent.runtime.knowledge;

import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockKnowledge;
import dev.mcagent.runtime.evidence.BlockEvidenceSnapshot;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.evidence.BlockObservation;
import dev.mcagent.runtime.evidence.EmbodiedWorldEvidence;
import dev.mcagent.runtime.evidence.EntityObservation;
import dev.mcagent.runtime.evidence.EntityTrack;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WorldKnowledgeTest {

    private static final String OVERWORLD = "minecraft:overworld";

    @BeforeAll
    static void bootMinecraftRegistries() {
        net.minecraft.SharedConstants.tryDetectVersion();
        net.minecraft.server.Bootstrap.bootStrap();
    }

    @Test
    void appliedFactsAreReadEverywhereAtOneRevisionAndSnapshotsStayFrozen() {
        WorldKnowledge knowledge = new EmbodiedWorldEvidence();
        BlockPos stone = new BlockPos(4, 70, -5);
        UUID zombie = UUID.fromString("00000000-0000-0000-0000-000000000001");
        var stoneId = CanonicalIdentifierGlob.compile("minecraft:stone");

        KnowledgeRevision applied = knowledge.apply(new AttributableWorldUpdate(List.of(
                new AttributableWorldUpdate.BlockFact(OVERWORLD, 20L,
                        BlockObservation.of(stone, Blocks.STONE.defaultBlockState(),
                                BlockEvidenceSource.ATTRIBUTABLE_ACTION))
        ), List.of(
                new AttributableWorldUpdate.EntityFact(OVERWORLD, 20L,
                        EntityObservation.attributable(zombie, "minecraft:zombie", null, null,
                                new Vec3(6, 70, -5), 20.0F, 20.0F))
        ), List.of()));

        assertEquals(new KnowledgeRevision(1L), applied);
        BlockKnowledge blocks = knowledge.blocks();
        BlockEvidenceSnapshot frozen = blocks.snapshot(OVERWORLD, stone, 16);
        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, blocks.cell(OVERWORLD, stone).state());
        assertEquals(List.of(stone), blocks.find(OVERWORLD, stoneId, null, 16).matches().stream()
                .map(BlockKnowledge.LocatedCell::position).toList());
        assertEquals(List.of(stone), blocks.knownWithin(OVERWORLD, stoneId, stone, 16).stream()
                .map(BlockKnowledge.LocatedCell::position).toList());
        assertFalse(blocks.region(OVERWORLD,
                BlockKnowledge.RegionBounds.between(stone, stone.east())).complete());
        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, frozen.block(stone).state());
        assertEquals(zombie, knowledge.entity(zombie).orElseThrow().uuid());
        assertEquals(List.of(zombie), knowledge.entities().stream()
                .map(EntityTrack::uuid).toList());
        assertEquals(new KnowledgeRevision(1L), knowledge.revision(),
                "reading must not publish a new revision");

        knowledge.apply(new AttributableWorldUpdate(List.of(
                new AttributableWorldUpdate.BlockFact(OVERWORLD, 21L,
                        BlockObservation.knownAir(stone, BlockEvidenceSource.MISMATCH))
        ), List.of(), List.of(zombie)));

        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, frozen.block(stone).state(),
                "a snapshot must stay frozen");
        assertEquals(BlockEvidenceCell.State.KNOWN_AIR, blocks.cell(OVERWORLD, stone).state());
        assertTrue(knowledge.entity(zombie).isEmpty());
    }

    @Test
    void onePhysicalResultPublishesAllBlockFactsAtOneRevision() {
        EmbodiedWorldEvidence knowledge = new EmbodiedWorldEvidence();
        BlockPos first = new BlockPos(1, 64, 1);
        BlockPos second = first.east();

        KnowledgeRevision published = knowledge.apply(new AttributableWorldUpdate(List.of(
                new AttributableWorldUpdate.BlockFact(OVERWORLD, 9L,
                        BlockObservation.of(first, Blocks.AIR.defaultBlockState(),
                                BlockEvidenceSource.ATTRIBUTABLE_ACTION)),
                new AttributableWorldUpdate.BlockFact(OVERWORLD, 9L,
                        BlockObservation.of(second, Blocks.STONE.defaultBlockState(),
                                BlockEvidenceSource.ATTRIBUTABLE_ACTION))
        ), List.of(), List.of()));

        assertEquals(published.value(),
                knowledge.blocks().cell(OVERWORLD, first).observationRevision());
        assertEquals(published.value(),
                knowledge.blocks().cell(OVERWORLD, second).observationRevision());
    }

    @Test
    void bodyUnavailableAdvancesTheRevisionWithoutChangingRetainedBlockContent() {
        WorldKnowledge knowledge = new EmbodiedWorldEvidence();
        BlockPos stone = new BlockPos(1, 64, 1);
        knowledge.apply(new AttributableWorldUpdate(List.of(
                new AttributableWorldUpdate.BlockFact(OVERWORLD, 10L,
                        BlockObservation.of(stone, Blocks.STONE.defaultBlockState(),
                                BlockEvidenceSource.ATTRIBUTABLE_ACTION))
        ), List.of(), List.of()));
        long content = knowledge.blocks().contentVersion();

        knowledge.apply(new AttributableWorldUpdate(List.of(), List.of(), List.of()));
        knowledge.publishBodyUnavailable(OVERWORLD, 11L);

        assertEquals(new KnowledgeRevision(3L), knowledge.revision());
        assertEquals(content, knowledge.blocks().contentVersion());
        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK,
                knowledge.blocks().cell(OVERWORLD, stone).state());
    }

    @Test
    void onePublicationExpiresBlocksAndEntitiesAcrossDimensions() {
        EmbodiedWorldEvidence knowledge = new EmbodiedWorldEvidence(
                new GroundedEvidencePolicy(5, 5, 360));
        BlockPos stone = new BlockPos(1, 64, 1);
        UUID sheep = UUID.fromString("00000000-0000-0000-0000-000000000002");
        knowledge.apply(new AttributableWorldUpdate(List.of(
                new AttributableWorldUpdate.BlockFact(OVERWORLD, 10L,
                        BlockObservation.of(stone, Blocks.STONE.defaultBlockState(),
                                BlockEvidenceSource.ATTRIBUTABLE_ACTION))
        ), List.of(
                new AttributableWorldUpdate.EntityFact(OVERWORLD, 10L,
                        EntityObservation.attributable(sheep, "minecraft:sheep", null, null,
                                new Vec3(2, 64, 2), 8.0F, 8.0F))
        ), List.of()));
        BlockEvidenceSnapshot before = knowledge.blocks().snapshot(OVERWORLD, stone, 1);
        long content = knowledge.blocks().contentVersion();

        knowledge.publishBodyUnavailable("minecraft:the_nether", 15L);

        assertEquals(content + 1L, knowledge.blocks().contentVersion());
        assertEquals(BlockEvidenceCell.State.UNKNOWN,
                knowledge.blocks().cell(OVERWORLD, stone).state());
        assertTrue(knowledge.entity(sheep).isEmpty());
        assertEquals(BlockEvidenceCell.State.KNOWN_BLOCK, before.block(stone).state());
    }
}
