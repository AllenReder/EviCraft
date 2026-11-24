package dev.mcagent.runtime.sdk;

import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockKnowledge;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.evidence.EntityTrackQuery;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierMatcher;
import dev.mcagent.runtime.knowledge.WorldKnowledge;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/** Store-only SDK adapter for the active World Run's selected World Knowledge. */
public final class DefaultRuntimeEvidenceGateway implements RuntimeEvidenceGateway {

    private final MinecraftServer server;

    public DefaultRuntimeEvidenceGateway(MinecraftServer server) {
        this.server = Objects.requireNonNull(server, "server");
    }

    @Override
    public List<RuntimeBlockEvidence> blockGet(
            String dimension, List<RuntimeBlockPosition> positions) {
        BlockKnowledge blocks = knowledge().blocks();
        return positions.stream()
                .map(DefaultRuntimeEvidenceGateway::blockPos)
                .map(position -> project(dimension, position, blocks.cell(dimension, position)))
                .toList();
    }

    @Override
    public RuntimeBlockFindResult blockFind(
            String dimension, CanonicalIdentifierMatcher pattern) {
        return blockFind(dimension, pattern, null, BlockKnowledge.MAX_FIND_RESULTS);
    }

    @Override
    public RuntimeBlockFindResult blockFind(
            String dimension, CanonicalIdentifierMatcher pattern,
            RuntimeBlockPosition origin, int limit) {
        BlockKnowledge.FindResult found = knowledge().blocks().find(
                dimension, pattern, origin == null ? null : blockPos(origin), limit);
        // A find over knowledge never claims the world holds no further match.
        return new RuntimeBlockFindResult(found.matches().stream()
                .map(match -> project(dimension, match.position(), match.cell()))
                .toList(), found.hasMore(), false);
    }

    @Override
    public RuntimeBlockRegionResult blockRegion(
            String dimension, BlockKnowledge.RegionBounds bounds) {
        BlockKnowledge.RegionResult region = knowledge().blocks().region(dimension, bounds);
        List<RuntimeBlockPaletteEntry> palette = new ArrayList<>();
        Map<RuntimeBlockPaletteEntry, Integer> paletteIndices = new LinkedHashMap<>();
        List<Integer> indices = new ArrayList<>(region.cells().size());
        for (BlockKnowledge.LocatedCell located : region.cells()) {
            RuntimeBlockPaletteEntry entry = palette(located.cell());
            Integer index = paletteIndices.get(entry);
            if (index == null) {
                index = palette.size();
                paletteIndices.put(entry, index);
                palette.add(entry);
            }
            indices.add(index);
        }
        BlockPos size = region.size();
        BlockPos min = bounds.min();
        return new RuntimeBlockRegionResult(dimension,
                new RuntimeBlockPosition(min.getX(), min.getY(), min.getZ()),
                new RuntimeBlockPosition(size.getX(), size.getY(), size.getZ()),
                palette, indices, region.complete());
    }

    @Override
    public Optional<RuntimeEntityTrack> entityGet(UUID uuid) {
        return knowledge().entity(uuid).map(this::project);
    }

    @Override
    public RuntimeEntityListResult entityList(
            String dimension,
            CanonicalIdentifierMatcher entityPattern,
            CanonicalIdentifierMatcher itemPattern) {
        EntityTrackQuery.ListResult listed = EntityTrackQuery.list(
                knowledge().entities(), dimension, entityPattern, itemPattern);
        return new RuntimeEntityListResult(
                listed.tracks().stream().map(this::project).toList(), listed.hasMore());
    }

    private RuntimeBlockEvidence project(
            String dimension, BlockPos position, BlockEvidenceCell cell) {
        RuntimeBlockPosition wirePosition = new RuntimeBlockPosition(
                position.getX(), position.getY(), position.getZ());
        return switch (cell.state()) {
            case UNKNOWN -> RuntimeBlockEvidence.unknown(dimension, wirePosition);
            case KNOWN_AIR -> RuntimeBlockEvidence.knownAir(dimension, wirePosition,
                    cell.source().wireValue(), cell.observedTick(), cell.observationRevision());
            case KNOWN_BLOCK -> RuntimeBlockEvidence.knownBlock(dimension, wirePosition,
                    cell.blockState(), cell.fluid(), cell.source().wireValue(),
                    cell.observedTick(), cell.observationRevision());
        };
    }

    private RuntimeEntityTrack project(EntityTrack track) {
        return new RuntimeEntityTrack(track.uuid(), track.dimension(), track.entityId(),
                track.itemId(), track.itemCount(), new RuntimeEntityPosition(
                track.position().x, track.position().y, track.position().z),
                RuntimeEntityTrack.State.valueOf(track.state().name()),
                track.source().wireValue(), track.observedTick(), track.observationRevision());
    }

    private static RuntimeBlockPaletteEntry palette(BlockEvidenceCell cell) {
        return switch (cell.state()) {
            case UNKNOWN -> RuntimeBlockPaletteEntry.unknown();
            case KNOWN_AIR -> RuntimeBlockPaletteEntry.knownAir(
                    cell.source().wireValue(), cell.observedTick(), cell.observationRevision());
            case KNOWN_BLOCK -> RuntimeBlockPaletteEntry.knownBlock(
                    cell.blockState(), cell.fluid(), cell.source().wireValue(),
                    cell.observedTick(), cell.observationRevision());
        };
    }

    private static BlockPos blockPos(RuntimeBlockPosition position) {
        return new BlockPos(position.x(), position.y(), position.z());
    }

    private WorldKnowledge knowledge() {
        return RuntimeBotManager.knowledge(server);
    }
}
