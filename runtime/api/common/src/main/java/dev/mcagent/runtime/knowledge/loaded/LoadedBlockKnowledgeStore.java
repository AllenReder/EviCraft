package dev.mcagent.runtime.knowledge.loaded;

import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockKnowledge;
import dev.mcagent.runtime.evidence.BlockObservation;
import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import it.unimi.dsi.fastutil.ints.Int2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Block knowledge of the loaded profile: the chunk columns one Virtual Client Chunk Tracker
 * holds, as of the latest publication, plus the facts verified by the Actor's own actions since.
 */
final class LoadedBlockKnowledgeStore extends BlockKnowledge {

    private static final BlockState AIR = Blocks.AIR.defaultBlockState();

    private final Long2ObjectOpenHashMap<Column> columns = new Long2ObjectOpenHashMap<>();
    private String dimension;
    private VirtualClientChunkTracker.Snapshot published;
    /** Whether a column has diverged from the tracker pages it was published from. */
    private boolean diverged;
    private int minSectionY;
    private int maxSectionY = -1;
    private long contentVersion;

    @Override
    public long contentVersion() {
        return contentVersion;
    }

    @Override
    protected int minSectionY(String dimension) {
        return dimension.equals(this.dimension) ? minSectionY : 0;
    }

    @Override
    protected int maxSectionY(String dimension) {
        return dimension.equals(this.dimension) ? maxSectionY : -1;
    }

    /** Adopt the tracker's columns; a column whose page is unchanged keeps its clocks. */
    void publish(
            VirtualClientChunkTracker.Snapshot snapshot, long observedTick, long revision) {
        if (snapshot == published && !diverged) return;
        boolean sameDimension = Objects.equals(dimension, snapshot.dimension());
        boolean changed = !sameDimension || columns.size() != snapshot.columns().size();
        Long2ObjectOpenHashMap<Column> previous = new Long2ObjectOpenHashMap<>(columns);
        columns.clear();
        minSectionY = 0;
        maxSectionY = -1;
        for (Map.Entry<Long, VirtualClientChunkTracker.ColumnPage> entry
                : snapshot.columns().entrySet()) {
            long key = entry.getKey();
            VirtualClientChunkTracker.ColumnPage page = entry.getValue();
            Column existing = sameDimension ? previous.get(key) : null;
            if (existing == null || existing.page != page) {
                existing = new Column(page, observedTick, revision);
                changed = true;
            }
            if (columns.isEmpty()) {
                minSectionY = page.minSectionY();
                maxSectionY = page.minSectionY() + page.sectionCount() - 1;
            } else {
                minSectionY = Math.min(minSectionY, page.minSectionY());
                maxSectionY = Math.max(maxSectionY, page.minSectionY() + page.sectionCount() - 1);
            }
            columns.put(key, existing);
        }
        dimension = snapshot.dimension();
        published = snapshot;
        diverged = false;
        if (changed) contentVersion++;
    }

    /** Make verified facts visible at once in the columns that are already loaded. */
    void apply(List<AttributableWorldUpdate.BlockFact> facts, long revision) {
        boolean changed = false;
        for (AttributableWorldUpdate.BlockFact fact : facts) {
            BlockPos position = fact.observation().position();
            if (!fact.dimension().equals(dimension)) continue;
            long key = ChunkPos.asLong(position.getX() >> 4, position.getZ() >> 4);
            Column column = columns.get(key);
            Loaded section = column == null ? null : column.section(position.getY() >> 4);
            if (section == null) continue;
            changed |= !sameFact(section.cell(localIndex(position)), fact.observation());
            columns.put(key, column.withFact(fact, revision));
            diverged = true;
        }
        if (changed) contentVersion++;
    }

    boolean covers(String dimension, BlockPos position) {
        return dimension.equals(this.dimension)
                && columns.containsKey(ChunkPos.asLong(position.getX() >> 4, position.getZ() >> 4));
    }

    @Override
    protected Section section(String dimension, int sectionX, int sectionY, int sectionZ) {
        if (!dimension.equals(this.dimension)) return null;
        Column column = columns.get(ChunkPos.asLong(sectionX, sectionZ));
        return column == null ? null : column.section(sectionY);
    }

    @Override
    protected void forEachSection(String dimension, SectionVisitor visitor) {
        if (!dimension.equals(this.dimension)) return;
        for (Column column : columns.values()) column.visit(visitor);
    }

    @Override
    protected void forEachSectionInColumns(
            String dimension, int minChunkX, int maxChunkX, int minChunkZ, int maxChunkZ,
            SectionVisitor visitor) {
        if (!dimension.equals(this.dimension)) return;
        for (int chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
            for (int chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
                Column column = columns.get(ChunkPos.asLong(chunkX, chunkZ));
                if (column != null) column.visit(visitor);
            }
        }
    }

    private static boolean sameFact(BlockEvidenceCell current, BlockObservation observation) {
        return current.source() == observation.source()
                && (observation.block() == null
                        ? current.state() == BlockEvidenceCell.State.KNOWN_AIR
                        : current.matches(observation.block()));
    }

    /** One published chunk column: the tracker page it shows and when it was adopted. */
    private static final class Column {
        private final VirtualClientChunkTracker.ColumnPage page;
        private final long observedTick;
        private final long revision;
        private final Loaded[] sections;

        private Column(VirtualClientChunkTracker.ColumnPage page, long observedTick, long revision) {
            this(page, observedTick, revision, new Loaded[page.sectionCount()]);
            for (int index = 0; index < sections.length; index++) {
                sections[index] = new Loaded(
                        page.sectionPage(page.minSectionY() + index), observedTick, revision, null);
            }
        }

        private Column(VirtualClientChunkTracker.ColumnPage page, long observedTick, long revision,
                       Loaded[] sections) {
            this.page = page;
            this.observedTick = observedTick;
            this.revision = revision;
            this.sections = sections;
        }

        private Loaded section(int sectionY) {
            int index = sectionY - page.minSectionY();
            return index < 0 || index >= sections.length ? null : sections[index];
        }

        private void visit(SectionVisitor visitor) {
            ChunkPos position = page.position();
            for (int index = 0; index < sections.length; index++) {
                visitor.visit(position.x, page.minSectionY() + index, position.z, sections[index]);
            }
        }

        private Column withFact(AttributableWorldUpdate.BlockFact fact, long factRevision) {
            BlockObservation observation = fact.observation();
            BlockPos position = observation.position();
            VirtualClientChunkTracker.ColumnPage replaced = page.withBlock(
                    position, observation.block() == null ? AIR : observation.block());
            int sectionY = position.getY() >> 4;
            Loaded[] updated = sections.clone();
            updated[sectionY - page.minSectionY()] = section(sectionY).withFact(
                    replaced.sectionPage(sectionY), localIndex(position), BlockEvidenceCell.from(
                            observation, fact.observedTick(), factRevision));
            return new Column(replaced, observedTick, revision, updated);
        }
    }

    /** One section of a published column. Immutable, so snapshots keep it as it is. */
    private static final class Loaded implements Section {
        private final VirtualClientChunkTracker.SectionPage page;
        private final long observedTick;
        private final long revision;
        /** Cells whose fact came from the Actor's own action; null when there are none. */
        private final Int2ObjectOpenHashMap<BlockEvidenceCell> attributable;

        private Loaded(VirtualClientChunkTracker.SectionPage page, long observedTick, long revision,
                       Int2ObjectOpenHashMap<BlockEvidenceCell> attributable) {
            this.page = page;
            this.observedTick = observedTick;
            this.revision = revision;
            this.attributable = attributable;
        }

        private Loaded withFact(
                VirtualClientChunkTracker.SectionPage replaced, int index, BlockEvidenceCell cell) {
            Int2ObjectOpenHashMap<BlockEvidenceCell> facts = attributable == null
                    ? new Int2ObjectOpenHashMap<>() : new Int2ObjectOpenHashMap<>(attributable);
            facts.put(index, cell);
            return new Loaded(replaced, observedTick, revision, facts);
        }

        @Override
        public BlockState state(int index) {
            BlockState state = page.block(index);
            return state.isAir() && state.getFluidState().isEmpty() ? AIR : state;
        }

        @Override
        public BlockEvidenceCell cell(int index) {
            BlockEvidenceCell fact = attributable == null ? null : attributable.get(index);
            return fact != null ? fact
                    : BlockEvidenceCell.loadedWorldState(page.block(index), observedTick, revision);
        }

        @Override
        public Block[] blocks() {
            return page.blocks();
        }
    }
}
