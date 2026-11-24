package dev.mcagent.runtime.evidence;

import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.PalettedContainer;

import java.util.Arrays;
import java.util.Map;
import java.util.WeakHashMap;

/**
 * Per-level cache of how each cell of a chunk section meets a sight ray, as one bit per cell
 * (bit index {@code x | z << 4 | y << 8}). Server-thread only. Block changes patch the cached
 * bits through {@link #blockChanged}; a reloaded chunk is recognised by its new section object.
 */
public final class VisibilityGrid {

    /** A section counts as in use by a sensor when a ray entered it this recently. */
    private static final long ACTIVE_TICKS = 40L;
    private static final long EVICTION_INTERVAL_TICKS = 1_200L;
    private static final long EVICTION_AGE_TICKS = 2_400L;
    private static final Map<ServerLevel, VisibilityGrid> GRIDS = new WeakHashMap<>();

    private final Long2ObjectOpenHashMap<Masks> sections = new Long2ObjectOpenHashMap<>();
    private long activeChanges;
    private long lastEviction;

    private VisibilityGrid() {}

    static VisibilityGrid of(ServerLevel level) {
        return GRIDS.computeIfAbsent(level, ignored -> new VisibilityGrid());
    }

    /** Called for every successful server block mutation. */
    public static void blockChanged(ServerLevel level, BlockPos position, BlockState state) {
        VisibilityGrid grid = GRIDS.get(level);
        if (grid == null) return;
        Masks masks = grid.sections.get(SectionPos.asLong(
                position.getX() >> 4, position.getY() >> 4, position.getZ() >> 4));
        if (masks == null) return;
        masks.set((position.getX() & 15) | (position.getZ() & 15) << 4 | (position.getY() & 15) << 8,
                BlockVisibility.classify(state));
        if (level.getServer().getTickCount() - masks.usedTick <= ACTIVE_TICKS) grid.activeChanges++;
    }

    /** Number of block changes so far inside sections a ray entered recently. */
    long activeChanges() {
        return activeChanges;
    }

    Masks masks(LevelChunkSection section, long sectionKey, long tick) {
        Masks masks = sections.get(sectionKey);
        if (masks == null || masks.section != section) {
            masks = Masks.of(section);
            sections.put(sectionKey, masks);
        }
        masks.usedTick = tick;
        return masks;
    }

    void evictUnused(long tick) {
        if (tick - lastEviction < EVICTION_INTERVAL_TICKS) return;
        lastEviction = tick;
        sections.values().removeIf(masks -> tick - masks.usedTick > EVICTION_AGE_TICKS);
    }

    static final class Masks {
        final LevelChunkSection section;
        final long[] air = new long[64];
        final long[] opaque = new long[64];
        final long[] water = new long[64];
        long usedTick;

        private Masks(LevelChunkSection section) {
            this.section = section;
        }

        private static Masks of(LevelChunkSection section) {
            Masks masks = new Masks(section);
            if (section.hasOnlyAir()) {
                Arrays.fill(masks.air, -1L);
                return masks;
            }
            PalettedContainer<BlockState> states = section.getStates();
            for (int index = 0; index < 4096; index++) {
                masks.set(index, BlockVisibility.classify(
                        states.get(index & 15, index >>> 8, (index >>> 4) & 15)));
            }
            return masks;
        }

        private void set(int index, byte visibility) {
            int word = index >>> 6;
            long bit = 1L << index;
            air[word] &= ~bit;
            opaque[word] &= ~bit;
            water[word] &= ~bit;
            if (visibility == BlockVisibility.AIR) air[word] |= bit;
            else if (visibility == BlockVisibility.OPAQUE) opaque[word] |= bit;
            else if (visibility == BlockVisibility.WATER) water[word] |= bit;
        }
    }
}
