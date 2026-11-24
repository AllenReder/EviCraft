package dev.mcagent.runtime.knowledge.loaded;

import it.unimi.dsi.fastutil.longs.Long2ObjectMaps;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.objects.ReferenceOpenHashSet;
import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;

import java.util.Map;
import java.util.Objects;

/** Mineflayer-style projection of complete chunk columns delivered to one headless Bot. */
public final class VirtualClientChunkTracker {

    private String dimension;
    // Packet ingestion is mutable; only publication copies the column index.
    private final Long2ObjectOpenHashMap<ColumnPage> columns = new Long2ObjectOpenHashMap<>();
    private Snapshot cachedSnapshot;
    private long generation;

    /** A pending vanilla delivery is not client-known, including a re-entering column. */
    public synchronized void pending(ChunkPos position) {
        Objects.requireNonNull(position, "position");
        if (!columns.containsKey(position.toLong())) return;
        replaceColumn(position.toLong(), null);
    }

    /** Copy a fully prepared vanilla chunk packet into immutable client-owned pages. */
    public synchronized void load(ServerLevel level, LevelChunk chunk) {
        Objects.requireNonNull(level, "level");
        Objects.requireNonNull(chunk, "chunk");
        String nextDimension = level.dimension().location().toString();
        switchDimension(nextDimension);
        replaceColumn(chunk.getPos().toLong(), ColumnPage.copyOf(level, chunk));
    }

    /** Remove coverage at the logical-view boundary, independent of server residency. */
    public synchronized void unload(ChunkPos position) {
        Objects.requireNonNull(position, "position");
        replaceColumn(position.toLong(), null);
    }

    /** Apply one block packet only when its complete column is already client-known. */
    public synchronized void update(String dimension, BlockPos position, BlockState state) {
        Objects.requireNonNull(dimension, "dimension");
        Objects.requireNonNull(position, "position");
        Objects.requireNonNull(state, "state");
        if (!dimension.equals(this.dimension)) return;
        long key = ChunkPos.asLong(SectionPos.blockToSectionCoord(position.getX()),
                SectionPos.blockToSectionCoord(position.getZ()));
        ColumnPage column = columns.get(key);
        if (column == null) return;
        ColumnPage updated = column.withBlock(position, state);
        if (updated != column) replaceColumn(key, updated);
    }

    public synchronized Snapshot snapshot() {
        if (cachedSnapshot == null) cachedSnapshot = new Snapshot(dimension, columns, generation);
        return cachedSnapshot;
    }

    synchronized void loadFixtureColumn(
            String dimension, ChunkPos position, int minSectionY, int sectionCount,
            Map<BlockPos, BlockState> blocks) {
        Objects.requireNonNull(dimension, "dimension");
        Objects.requireNonNull(position, "position");
        Objects.requireNonNull(blocks, "blocks");
        switchDimension(dimension);
        replaceColumn(position.toLong(), ColumnPage.fixture(
                position, minSectionY, sectionCount, blocks));
    }

    private void switchDimension(String nextDimension) {
        if (nextDimension.equals(dimension)) return;
        dimension = nextDimension;
        cachedSnapshot = null;
        if (!columns.isEmpty()) {
            columns.clear();
            generation = Math.incrementExact(generation);
        }
    }

    private void replaceColumn(long key, ColumnPage replacement) {
        ColumnPage previous = columns.get(key);
        if (previous == replacement || previous == null && replacement == null) return;
        if (replacement == null) columns.remove(key);
        else columns.put(key, replacement);
        cachedSnapshot = null;
        generation = Math.incrementExact(generation);
    }

    public record Snapshot(String dimension, Map<Long, ColumnPage> columns, long generation) {

        public Snapshot {
            // Packed chunk coordinates collide under Long.hashCode (x ^ z); this map mixes them.
            columns = Long2ObjectMaps.unmodifiable(new Long2ObjectOpenHashMap<>(columns));
            if (generation < 0L) throw new IllegalArgumentException("generation must not be negative");
        }

        ColumnPage column(ChunkPos position) {
            return columns.get(Objects.requireNonNull(position, "position").toLong());
        }

        public boolean contains(ChunkPos position) {
            return columns.containsKey(Objects.requireNonNull(position, "position").toLong());
        }
    }

    public static final class ColumnPage {
        private final ChunkPos position;
        private final int minSectionY;
        /** One page per section, lowest first. */
        private final SectionPage[] sections;

        private ColumnPage(ChunkPos position, int minSectionY, SectionPage[] sections) {
            this.position = position;
            this.minSectionY = minSectionY;
            this.sections = sections;
        }

        private static ColumnPage copyOf(ServerLevel level, LevelChunk chunk) {
            LevelChunkSection[] liveSections = chunk.getSections();
            SectionPage[] sections = new SectionPage[liveSections.length];
            for (int index = 0; index < liveSections.length; index++) {
                sections[index] = SectionPage.copyOf(liveSections[index]);
            }
            return new ColumnPage(chunk.getPos(), level.getMinSection(), sections);
        }

        private static ColumnPage fixture(
                ChunkPos position, int minSectionY, int sectionCount,
                Map<BlockPos, BlockState> blocks) {
            if (sectionCount < 1) throw new IllegalArgumentException("sectionCount must be positive");
            BlockState[][] states = new BlockState[sectionCount][16 * 16 * 16];
            for (BlockState[] section : states) {
                java.util.Arrays.fill(section, Blocks.AIR.defaultBlockState());
            }
            blocks.forEach((block, state) -> {
                if (block.getX() >> 4 != position.x || block.getZ() >> 4 != position.z) {
                    throw new IllegalArgumentException("fixture block must belong to its column");
                }
                int index = SectionPos.blockToSectionCoord(block.getY()) - minSectionY;
                if (index < 0 || index >= sectionCount) {
                    throw new IllegalArgumentException("fixture block is outside column height");
                }
                states[index][SectionPage.index(block)] = state;
            });
            SectionPage[] sections = new SectionPage[sectionCount];
            for (int index = 0; index < sectionCount; index++) {
                sections[index] = new SectionPage(states[index]);
            }
            return new ColumnPage(position, minSectionY, sections);
        }

        public BlockState block(BlockPos block) {
            SectionPage section = sectionPage(SectionPos.blockToSectionCoord(block.getY()));
            return section == null ? null : section.block(block);
        }

        public ChunkPos position() {
            return position;
        }

        public int minSectionY() {
            return minSectionY;
        }

        public int sectionCount() {
            return sections.length;
        }

        /** The page of one section, or {@code null} outside the column's height. */
        public SectionPage sectionPage(int sectionY) {
            int index = sectionY - minSectionY;
            return index < 0 || index >= sections.length ? null : sections[index];
        }

        public ColumnPage withBlock(BlockPos position, BlockState state) {
            int sectionY = SectionPos.blockToSectionCoord(position.getY());
            SectionPage current = sectionPage(sectionY);
            if (current == null) return this;
            SectionPage replacement = current.withBlock(position, state);
            if (replacement == current) return this;
            SectionPage[] updated = sections.clone();
            updated[sectionY - minSectionY] = replacement;
            return new ColumnPage(this.position, minSectionY, updated);
        }
    }

    /** Immutable cells of one chunk section; a cell index is {@code x | z << 4 | y << 8}. */
    public static final class SectionPage {
        private final BlockState[] states;
        private final Block[] blocks;

        private SectionPage(BlockState[] states) {
            this.states = states;
            ReferenceOpenHashSet<Block> distinct = new ReferenceOpenHashSet<>();
            for (BlockState state : states) {
                if (!state.isAir()) distinct.add(state.getBlock());
            }
            this.blocks = distinct.toArray(new Block[0]);
        }

        private static SectionPage copyOf(LevelChunkSection section) {
            BlockState[] states = new BlockState[16 * 16 * 16];
            for (int y = 0; y < 16; y++) {
                for (int z = 0; z < 16; z++) {
                    for (int x = 0; x < 16; x++) {
                        states[(y << 8) | (z << 4) | x] = section.getBlockState(x, y, z);
                    }
                }
            }
            return new SectionPage(states);
        }

        private BlockState block(BlockPos position) {
            return states[index(position)];
        }

        public BlockState block(int localIndex) {
            return states[localIndex];
        }

        /** The distinct non-air blocks of this section. */
        public Block[] blocks() {
            return blocks;
        }

        private SectionPage withBlock(BlockPos position, BlockState state) {
            int index = index(position);
            if (states[index].equals(state)) return this;
            BlockState[] copy = states.clone();
            copy[index] = state;
            return new SectionPage(copy);
        }

        private static int index(BlockPos position) {
            return (SectionPos.sectionRelative(position.getY()) << 8)
                    | (SectionPos.sectionRelative(position.getZ()) << 4)
                    | SectionPos.sectionRelative(position.getX());
        }
    }
}
