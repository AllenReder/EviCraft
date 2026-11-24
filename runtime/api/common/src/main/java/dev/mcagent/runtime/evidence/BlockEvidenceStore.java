package dev.mcagent.runtime.evidence;

import dev.mcagent.runtime.knowledge.AttributableWorldUpdate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

import it.unimi.dsi.fastutil.ints.IntArrayList;
import it.unimi.dsi.fastutil.longs.Long2ObjectMap;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.objects.ReferenceOpenHashSet;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;

/**
 * Process-local, optionally expiring block memory for one World Run.
 *
 * <p>Memory is held in one page per 16×16×16 chunk section. A page keeps its cells in flat
 * arrays, so a dense sight frame merges with a few word operations per 64 cells. A snapshot
 * marks the pages it captures as shared; the next write to a shared page copies it first, so a
 * snapshot stays frozen without the store copying anything it does not change.
 *
 * <p>Server-thread only. Snapshots may be read from any thread.
 */
public final class BlockEvidenceStore extends BlockKnowledge {

    private static final BlockEvidenceSource[] SOURCES = BlockEvidenceSource.values();
    private static final byte VISION = (byte) BlockEvidenceSource.VISION.ordinal();
    private static final long UNSCHEDULED = Long.MAX_VALUE;
    private static final BlockState AIR = Blocks.AIR.defaultBlockState();

    private final Map<String, Dimension> dimensions = new HashMap<>();
    /** Null when Block Evidence never expires, avoiding dormant index cost. */
    private final TreeMap<Long, Set<SectionKey>> expiryDeadlines;
    private final int expiryTicks;
    /** Each cell stores an index into these parallel arrays instead of its own two clocks. */
    private long[] stampTicks = new long[1024];
    private long[] stampRevisions = new long[1024];
    private int stampCount;
    private long revision;
    private long contentVersion;

    public BlockEvidenceStore() {
        this(-1);
    }

    public BlockEvidenceStore(int expiryTicks) {
        if (expiryTicks != -1 && expiryTicks < 1) {
            throw new IllegalArgumentException("expiryTicks must be -1 or positive");
        }
        this.expiryTicks = expiryTicks;
        this.expiryDeadlines = expiryTicks == -1 ? null : new TreeMap<>();
    }

    @Override
    public long contentVersion() {
        return contentVersion;
    }

    /** Revision of the latest publication. */
    public long revision() {
        return revision;
    }

    /** Diagnostic size of one dimension: sections, known cells, block cells, approximate bytes. */
    long[] size(String dimension) {
        Dimension known = dimensions.get(dimension);
        long[] size = new long[4];
        if (known == null) return size;
        for (SectionPage page : known.pages.values()) {
            size[0]++;
            for (int word = 0; word < 64; word++) {
                size[1] += Long.bitCount(page.known[word]);
                size[2] += Long.bitCount(page.block[word]);
            }
            size[3] += 1_024 + 16_384 + (page.states == null ? 0 : 16_384)
                    + (page.sources == null ? 0 : 4_096);
        }
        return size;
    }

    public long publishFrame(
            String dimension, long observedTick, List<BlockObservation> observations) {
        return publishFrame(dimension, observedTick, null, observations);
    }

    /** Publish one sight frame, then the frame's individually sourced observations. */
    long publishFrame(String dimension, long observedTick, SightFrame sight,
                      List<BlockObservation> observations) {
        Objects.requireNonNull(dimension, "dimension");
        Objects.requireNonNull(observations, "observations");
        if (observedTick < 0) throw new IllegalArgumentException("observedTick must be non-negative");
        long nextRevision = Math.incrementExact(revision);
        int stamp = stamp(observedTick, nextRevision);
        boolean changed = false;
        if (sight != null) changed = merge(dimension, observedTick, stamp, sight);
        for (BlockObservation observation : observations) {
            changed |= write(dimension, observedTick, stamp, observation);
        }
        changed |= expireDueSections(observedTick);
        revision = nextRevision;
        if (changed) contentVersion = Math.incrementExact(contentVersion);
        return nextRevision;
    }

    /** Publish one verified multi-fact block batch at one revision. */
    long publishAttributable(List<AttributableWorldUpdate.BlockFact> evidence) {
        long nextRevision = Math.incrementExact(revision);
        boolean changed = false;
        for (AttributableWorldUpdate.BlockFact fact : evidence) {
            changed |= write(fact.dimension(), fact.observedTick(),
                    stamp(fact.observedTick(), nextRevision), fact.observation());
        }
        revision = nextRevision;
        if (changed) contentVersion = Math.incrementExact(contentVersion);
        return nextRevision;
    }

    @Override
    protected Section section(String dimension, int sectionX, int sectionY, int sectionZ) {
        Dimension known = dimensions.get(dimension);
        return known == null ? null
                : known.pages.get(SectionPos.asLong(sectionX, sectionY, sectionZ));
    }

    @Override
    protected void forEachSection(String dimension, SectionVisitor visitor) {
        Dimension known = dimensions.get(dimension);
        if (known == null) return;
        for (Long2ObjectMap.Entry<SectionPage> entry : known.pages.long2ObjectEntrySet()) {
            long key = entry.getLongKey();
            visitor.visit(SectionPos.x(key), SectionPos.y(key), SectionPos.z(key), entry.getValue());
        }
    }

    @Override
    protected void forEachSectionInColumns(
            String dimension, int minChunkX, int maxChunkX, int minChunkZ, int maxChunkZ,
            SectionVisitor visitor) {
        Dimension known = dimensions.get(dimension);
        if (known == null) return;
        for (int chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
            for (int chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
                for (int sectionY = known.minSectionY; sectionY <= known.maxSectionY; sectionY++) {
                    SectionPage page = known.pages.get(SectionPos.asLong(chunkX, sectionY, chunkZ));
                    if (page != null) visitor.visit(chunkX, sectionY, chunkZ, page);
                }
            }
        }
    }

    @Override
    protected int minSectionY(String dimension) {
        Dimension known = dimensions.get(dimension);
        return known == null ? 0 : known.minSectionY;
    }

    @Override
    protected int maxSectionY(String dimension) {
        Dimension known = dimensions.get(dimension);
        return known == null ? -1 : known.maxSectionY;
    }

    /** A snapshot holds this page: the next write replaces it with a copy. */
    @Override
    protected void freeze(Section section) {
        ((SectionPage) section).shared = true;
    }

    private static long sectionKey(BlockPos position) {
        return SectionPos.asLong(position.getX() >> 4, position.getY() >> 4, position.getZ() >> 4);
    }

    private int stamp(long tick, long observationRevision) {
        if (stampCount > 0 && stampTicks[stampCount - 1] == tick
                && stampRevisions[stampCount - 1] == observationRevision) {
            return stampCount - 1;
        }
        if (stampCount == stampTicks.length) {
            // Entries are never rewritten, so frozen pages keep reading the stamps they hold.
            stampTicks = Arrays.copyOf(stampTicks, stampCount * 2);
            stampRevisions = Arrays.copyOf(stampRevisions, stampCount * 2);
        }
        stampTicks[stampCount] = tick;
        stampRevisions[stampCount] = observationRevision;
        return stampCount++;
    }

    private SectionPage writablePage(String dimension, long sectionKey) {
        Dimension known = dimensions.computeIfAbsent(dimension, ignored -> new Dimension());
        SectionPage page = known.pages.get(sectionKey);
        if (page == null) {
            page = new SectionPage();
            known.pages.put(sectionKey, page);
            int sectionY = SectionPos.y(sectionKey);
            known.minSectionY = Math.min(known.minSectionY, sectionY);
            known.maxSectionY = Math.max(known.maxSectionY, sectionY);
        } else if (page.shared) {
            page = page.copy();
            known.pages.put(sectionKey, page);
        }
        return page;
    }

    private boolean merge(String dimension, long observedTick, int stamp, SightFrame sight) {
        boolean changed = false;
        for (int section = 0; section < sight.sectionCount(); section++) {
            long key = SectionPos.asLong(
                    sight.sectionX(section), sight.sectionY(section), sight.sectionZ(section));
            SectionPage page = writablePage(dimension, key);
            long[] air = sight.air(section);
            long[] block = sight.block(section);
            int[] stamps = page.stamps;
            for (int word = 0; word < 64; word++) {
                long seenAir = air[word];
                long seenBlock = block[word];
                if (seenAir != 0) {
                    long wasBlock = seenAir & page.block[word];
                    for (long bits = wasBlock; bits != 0; bits &= bits - 1) {
                        page.forgetBlock(word << 6 | Long.numberOfTrailingZeros(bits));
                    }
                    if (wasBlock != 0 || (seenAir & ~page.known[word]) != 0) changed = true;
                    page.known[word] |= seenAir;
                    byte[] sources = page.sources;
                    for (long bits = seenAir; bits != 0; bits &= bits - 1) {
                        int index = word << 6 | Long.numberOfTrailingZeros(bits);
                        stamps[index] = stamp;
                        if (sources != null) sources[index] = VISION;
                    }
                }
                for (long bits = seenBlock; bits != 0; bits &= bits - 1) {
                    int index = word << 6 | Long.numberOfTrailingZeros(bits);
                    BlockState state = sight.state(section, index);
                    changed |= state.isAir() && state.getFluidState().isEmpty()
                            ? page.writeAir(index, stamp, VISION)
                            : page.writeBlock(index, state, stamp, VISION);
                }
            }
            schedule(dimension, key, page, observedTick);
        }
        return changed;
    }

    private boolean write(String dimension, long observedTick, int stamp,
                          BlockObservation observation) {
        BlockPos position = observation.position();
        long key = sectionKey(position);
        SectionPage page = writablePage(dimension, key);
        int index = localIndex(position);
        byte source = (byte) observation.source().ordinal();
        boolean changed = observation.block() == null
                ? page.writeAir(index, stamp, source)
                : page.writeBlock(index, observation.block(), stamp, source);
        schedule(dimension, key, page, observedTick);
        return changed;
    }

    /**
     * A page's deadline is a lower bound on when its oldest cell is due: writes only make cells
     * newer, so the deadline is recomputed from the cells when it comes due, not on every write.
     */
    private void schedule(String dimension, long sectionKey, SectionPage page, long observedTick) {
        if (expiryDeadlines == null) return;
        long deadline = Math.addExact(observedTick, expiryTicks);
        if (deadline >= page.deadline) return;
        SectionKey key = new SectionKey(dimension, sectionKey);
        if (page.deadline != UNSCHEDULED) {
            Set<SectionKey> previous = expiryDeadlines.get(page.deadline);
            previous.remove(key);
            if (previous.isEmpty()) expiryDeadlines.remove(page.deadline);
        }
        page.deadline = deadline;
        expiryDeadlines.computeIfAbsent(deadline, ignored -> new HashSet<>()).add(key);
    }

    private boolean expireDueSections(long observedTick) {
        if (expiryDeadlines == null) return false;
        boolean changed = false;
        IntArrayList expired = new IntArrayList();
        while (!expiryDeadlines.isEmpty() && expiryDeadlines.firstKey() <= observedTick) {
            Map.Entry<Long, Set<SectionKey>> dueEntry = expiryDeadlines.pollFirstEntry();
            for (SectionKey due : dueEntry.getValue()) {
                Dimension known = dimensions.get(due.dimension());
                SectionPage page = known == null ? null : known.pages.get(due.sectionKey());
                if (page == null || page.deadline != dueEntry.getKey()) continue;
                page.deadline = UNSCHEDULED;

                expired.clear();
                long oldest = Long.MAX_VALUE;
                for (int word = 0; word < 64; word++) {
                    for (long bits = page.known[word]; bits != 0; bits &= bits - 1) {
                        int index = word << 6 | Long.numberOfTrailingZeros(bits);
                        long cellTick = stampTicks[page.stamps[index]];
                        if (observedTick - cellTick >= expiryTicks) expired.add(index);
                        else oldest = Math.min(oldest, cellTick);
                    }
                }
                changed |= !expired.isEmpty();
                if (oldest == Long.MAX_VALUE) {
                    known.pages.remove(due.sectionKey());
                    if (known.pages.isEmpty()) dimensions.remove(due.dimension());
                    continue;
                }
                if (!expired.isEmpty()) {
                    if (page.shared) {
                        page = page.copy();
                        known.pages.put(due.sectionKey(), page);
                    }
                    for (int at = 0; at < expired.size(); at++) page.forget(expired.getInt(at));
                }
                schedule(due.dimension(), due.sectionKey(), page, oldest);
            }
        }
        return changed;
    }

    private static final class Dimension {
        private final Long2ObjectOpenHashMap<SectionPage> pages = new Long2ObjectOpenHashMap<>();
        private int minSectionY = Integer.MAX_VALUE;
        private int maxSectionY = Integer.MIN_VALUE;
    }

    /** Cells of one chunk section; bit and array index is {@code x | z << 4 | y << 8}. */
    private final class SectionPage implements Section {
        private final long[] known = new long[64];
        private final long[] block = new long[64];
        private final int[] stamps = new int[4096];
        /** Decoded states of the block cells; allocated with the first block. */
        private BlockState[] states;
        /** Null while every cell was seen; otherwise one source ordinal per cell. */
        private byte[] sources;
        /** Distinct blocks on this page, rebuilt on demand after a block cell changes. */
        private Block[] blocks;
        private long deadline = UNSCHEDULED;
        /** Set once a snapshot holds this page; the store then replaces it instead of writing. */
        private boolean shared;

        private SectionPage copy() {
            SectionPage copy = new SectionPage();
            System.arraycopy(known, 0, copy.known, 0, 64);
            System.arraycopy(block, 0, copy.block, 0, 64);
            System.arraycopy(stamps, 0, copy.stamps, 0, 4096);
            if (states != null) copy.states = states.clone();
            if (sources != null) copy.sources = sources.clone();
            copy.blocks = blocks;
            copy.deadline = deadline;
            return copy;
        }

        private boolean writeAir(int index, int stamp, byte source) {
            int word = index >>> 6;
            long bit = 1L << index;
            boolean wasAir = (known[word] & bit) != 0 && (block[word] & bit) == 0;
            if ((block[word] & bit) != 0) forgetBlock(index);
            known[word] |= bit;
            stamps[index] = stamp;
            source(index, source);
            return !wasAir;
        }

        private boolean writeBlock(int index, BlockState state, int stamp, byte source) {
            int word = index >>> 6;
            long bit = 1L << index;
            boolean same = (block[word] & bit) != 0 && states[index] == state;
            if (!same) {
                if (states == null) states = new BlockState[4096];
                states[index] = state;
                known[word] |= bit;
                block[word] |= bit;
                blocks = null;
            }
            stamps[index] = stamp;
            source(index, source);
            return !same;
        }

        private void source(int index, byte source) {
            if (sources == null) {
                if (source == VISION) return;
                sources = new byte[4096];
                Arrays.fill(sources, VISION);
            }
            sources[index] = source;
        }

        private void forgetBlock(int index) {
            states[index] = null;
            block[index >>> 6] &= ~(1L << index);
            blocks = null;
        }

        private void forget(int index) {
            if ((block[index >>> 6] & 1L << index) != 0) forgetBlock(index);
            known[index >>> 6] &= ~(1L << index);
        }

        @Override
        public BlockEvidenceCell cell(int index) {
            int word = index >>> 6;
            long bit = 1L << index;
            if ((known[word] & bit) == 0) return BlockEvidenceCell.unknown();
            BlockEvidenceSource source = sources == null
                    ? BlockEvidenceSource.VISION : SOURCES[sources[index]];
            long tick = stampTicks[stamps[index]];
            long observationRevision = stampRevisions[stamps[index]];
            if ((block[word] & bit) == 0) {
                return new BlockEvidenceCell(BlockEvidenceCell.State.KNOWN_AIR, null, null,
                        source, tick, observationRevision);
            }
            return new BlockEvidenceCell(BlockEvidenceCell.State.KNOWN_BLOCK,
                    BlockStateCanonicalizer.block(states[index]),
                    BlockStateCanonicalizer.fluid(states[index].getFluidState()),
                    source, tick, observationRevision);
        }

        @Override
        public BlockState state(int index) {
            int word = index >>> 6;
            long bit = 1L << index;
            if ((known[word] & bit) == 0) return null;
            return (block[word] & bit) == 0 ? AIR : states[index];
        }

        @Override
        public Block[] blocks() {
            if (blocks == null) {
                ReferenceOpenHashSet<Block> distinct = new ReferenceOpenHashSet<>();
                for (int word = 0; word < 64; word++) {
                    for (long bits = block[word]; bits != 0; bits &= bits - 1) {
                        distinct.add(states[word << 6 | Long.numberOfTrailingZeros(bits)].getBlock());
                    }
                }
                blocks = distinct.toArray(new Block[0]);
            }
            return blocks;
        }
    }

    private record SectionKey(String dimension, long sectionKey) {}
}
