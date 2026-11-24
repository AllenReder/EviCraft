package dev.mcagent.runtime.evidence;

import dev.mcagent.runtime.knowledge.CanonicalIdentifierMatcher;
import it.unimi.dsi.fastutil.objects.Reference2BooleanOpenHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.PriorityQueue;

/**
 * The block facts one World Run holds, addressed as 16×16×16 chunk sections.
 *
 * <p>A provider decides what is admitted — what the Actor has seen, or what its client has
 * loaded — and hands out its sections. Every query is answered here from those sections, so
 * both providers find, order, bound and freeze block facts in exactly the same way.
 *
 * <p>Server-thread only. A {@link BlockEvidenceSnapshot} may be read from any thread.
 */
public abstract class BlockKnowledge {

    public static final int MAX_FIND_RESULTS = 256;
    public static final int MAX_REGION_AXIS = 128;
    public static final int MAX_REGION_CELLS = 65_536;

    /** Cells of one chunk section; a cell index is {@code x | z << 4 | y << 8}. */
    public interface Section {
        /** Air for known air, the block state for a known block, {@code null} when unknown. */
        BlockState state(int index);

        /** The same fact with its provenance and clocks. Server-thread only. */
        BlockEvidenceCell cell(int index);

        /** The distinct blocks of this section's known non-air cells. Server-thread only. */
        Block[] blocks();
    }

    protected interface SectionVisitor {
        void visit(int sectionX, int sectionY, int sectionZ, Section section);
    }

    /** The section at these section coordinates, or {@code null} when nothing in it is known. */
    protected abstract Section section(String dimension, int sectionX, int sectionY, int sectionZ);

    protected abstract void forEachSection(String dimension, SectionVisitor visitor);

    /** Visit the sections of the chunk columns in the inclusive chunk-coordinate range. */
    protected abstract void forEachSectionInColumns(
            String dimension, int minChunkX, int maxChunkX, int minChunkZ, int maxChunkZ,
            SectionVisitor visitor);

    /** The lowest section coordinate that may hold a known cell in {@code dimension}. */
    protected abstract int minSectionY(String dimension);

    /** The highest such section coordinate; below {@link #minSectionY} when nothing is known. */
    protected abstract int maxSectionY(String dimension);

    /** Called for a section a snapshot keeps: from now on it must not change. */
    protected void freeze(Section section) {}

    /** Changes exactly when a known block fact or the set of known cells changes. */
    public abstract long contentVersion();

    public final BlockEvidenceCell cell(String dimension, BlockPos position) {
        Section section = section(dimension,
                position.getX() >> 4, position.getY() >> 4, position.getZ() >> 4);
        return section == null ? BlockEvidenceCell.unknown() : section.cell(localIndex(position));
    }

    /**
     * Known blocks whose block id matches: the nearest to {@code origin} first, or in x, y, z
     * order when {@code origin} is {@code null}. At most {@code limit} are returned.
     */
    public final FindResult find(
            String dimension, CanonicalIdentifierMatcher matcher, BlockPos origin, int limit) {
        if (limit < 1 || limit > MAX_FIND_RESULTS) {
            throw new IllegalArgumentException("block find limit must be from 1 through 256");
        }
        BlockMatcher blocks = new BlockMatcher(matcher);
        List<Candidate> candidates = new ArrayList<>();
        forEachSection(dimension, (x, y, z, section) -> {
            if (blocks.mayMatch(section)) candidates.add(new Candidate(x, y, z, section, origin));
        });
        candidates.sort(Candidate.ORDER);
        // One match beyond the limit tells whether more exist.
        int capacity = limit + 1;
        PriorityQueue<Match> farthestFirst = new PriorityQueue<>(Match.ORDER.reversed());
        for (Candidate candidate : candidates) {
            // Sections come nearest first, so once one cannot beat the worst kept match, none can.
            if (farthestFirst.size() == capacity
                    && candidate.startsAfter(farthestFirst.peek(), origin)) break;
            scan(candidate.x, candidate.y, candidate.z, candidate.section, blocks,
                    Integer.MIN_VALUE, Integer.MAX_VALUE, Integer.MIN_VALUE, Integer.MAX_VALUE,
                    (x, y, z, section, index) -> {
                        Match match = new Match(
                                origin == null ? 0L : squaredDistance(x, y, z, origin),
                                x, y, z, section, index);
                        if (farthestFirst.size() < capacity) {
                            farthestFirst.add(match);
                        } else if (Match.ORDER.compare(match, farthestFirst.peek()) < 0) {
                            farthestFirst.poll();
                            farthestFirst.add(match);
                        }
                    });
        }
        List<Match> ordered = new ArrayList<>(farthestFirst);
        ordered.sort(Match.ORDER);
        boolean hasMore = ordered.size() > limit;
        return new FindResult(located(hasMore ? ordered.subList(0, limit) : ordered), hasMore);
    }

    /** Every known block whose block id matches within a horizontal square, in x, y, z order. */
    public final List<LocatedCell> knownWithin(
            String dimension, CanonicalIdentifierMatcher matcher,
            BlockPos center, int horizontalRadius) {
        BlockMatcher blocks = new BlockMatcher(matcher);
        int minX = center.getX() - horizontalRadius;
        int maxX = center.getX() + horizontalRadius;
        int minZ = center.getZ() - horizontalRadius;
        int maxZ = center.getZ() + horizontalRadius;
        List<Match> matches = new ArrayList<>();
        forEachSectionInColumns(dimension, minX >> 4, maxX >> 4, minZ >> 4, maxZ >> 4,
                (sectionX, sectionY, sectionZ, section) -> {
                    if (!blocks.mayMatch(section)) return;
                    scan(sectionX, sectionY, sectionZ, section, blocks, minX, maxX, minZ, maxZ,
                            (x, y, z, found, index) ->
                                    matches.add(new Match(0L, x, y, z, found, index)));
                });
        matches.sort(Match.ORDER);
        return located(matches);
    }

    /** Every cell of an inclusive box, x fastest, then y, then z. */
    public final RegionResult region(String dimension, RegionBounds bounds) {
        BlockPos min = bounds.min();
        BlockPos size = bounds.size();
        List<LocatedCell> cells = new ArrayList<>(size.getX() * size.getY() * size.getZ());
        boolean complete = true;
        for (int dz = 0; dz < size.getZ(); dz++) {
            for (int dy = 0; dy < size.getY(); dy++) {
                for (int dx = 0; dx < size.getX(); dx++) {
                    BlockPos position = min.offset(dx, dy, dz);
                    BlockEvidenceCell cell = cell(dimension, position);
                    cells.add(new LocatedCell(position, cell));
                    complete &= cell.state() != BlockEvidenceCell.State.UNKNOWN;
                }
            }
        }
        return new RegionResult(size, cells, complete);
    }

    /** Freeze the chunk columns within {@code blockRadius} of {@code center} for planning. */
    public final BlockEvidenceSnapshot snapshot(
            String dimension, BlockPos center, int blockRadius) {
        if (blockRadius < 1) throw new IllegalArgumentException("blockRadius must be positive");
        int minChunkX = (center.getX() - blockRadius) >> 4;
        int maxChunkX = (center.getX() + blockRadius) >> 4;
        int minChunkZ = (center.getZ() - blockRadius) >> 4;
        int maxChunkZ = (center.getZ() + blockRadius) >> 4;
        int minSectionY = minSectionY(dimension);
        int sizeX = maxChunkX - minChunkX + 1;
        int sizeY = Math.max(0, maxSectionY(dimension) - minSectionY + 1);
        int sizeZ = maxChunkZ - minChunkZ + 1;
        Section[] grid = new Section[sizeX * sizeY * sizeZ];
        forEachSectionInColumns(dimension, minChunkX, maxChunkX, minChunkZ, maxChunkZ,
                (x, y, z, section) -> {
                    freeze(section);
                    grid[((x - minChunkX) * sizeZ + z - minChunkZ) * sizeY + y - minSectionY] =
                            section;
                });
        return new BlockEvidenceSnapshot(grid, minChunkX, minSectionY, minChunkZ,
                sizeX, sizeY, sizeZ, contentVersion());
    }

    protected static int localIndex(BlockPos position) {
        return (position.getX() & 15) | (position.getZ() & 15) << 4 | (position.getY() & 15) << 8;
    }

    private interface MatchVisitor {
        void visit(int x, int y, int z, Section section, int index);
    }

    private static void scan(
            int sectionX, int sectionY, int sectionZ, Section section, BlockMatcher blocks,
            int minX, int maxX, int minZ, int maxZ, MatchVisitor visitor) {
        int baseX = sectionX << 4;
        int baseY = sectionY << 4;
        int baseZ = sectionZ << 4;
        for (int index = 0; index < 4096; index++) {
            BlockState state = section.state(index);
            if (state == null || state.isAir() || !blocks.matches(state.getBlock())) continue;
            int x = baseX + (index & 15);
            int z = baseZ + ((index >>> 4) & 15);
            if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
            visitor.visit(x, baseY + (index >>> 8), z, section, index);
        }
    }

    private static List<LocatedCell> located(List<Match> matches) {
        List<LocatedCell> located = new ArrayList<>(matches.size());
        for (Match match : matches) {
            located.add(new LocatedCell(new BlockPos(match.x, match.y, match.z),
                    match.section.cell(match.index)));
        }
        return located;
    }

    private static long squaredDistance(int x, int y, int z, BlockPos origin) {
        long dx = (long) x - origin.getX();
        long dy = (long) y - origin.getY();
        long dz = (long) z - origin.getZ();
        return dx * dx + dy * dy + dz * dz;
    }

    /** One block-id pattern, tested once per block rather than once per cell. */
    private static final class BlockMatcher {
        private final CanonicalIdentifierMatcher matcher;
        private final Reference2BooleanOpenHashMap<Block> decided =
                new Reference2BooleanOpenHashMap<>();

        private BlockMatcher(CanonicalIdentifierMatcher matcher) {
            this.matcher = Objects.requireNonNull(matcher, "matcher");
        }

        private boolean mayMatch(Section section) {
            for (Block block : section.blocks()) {
                if (matches(block)) return true;
            }
            return false;
        }

        private boolean matches(Block block) {
            if (decided.containsKey(block)) return decided.getBoolean(block);
            boolean matches = matcher.matches(BuiltInRegistries.BLOCK.getKey(block).toString());
            decided.put(block, matches);
            return matches;
        }
    }

    /** A section with its coordinates and the least squared distance from a find origin. */
    private static final class Candidate {
        private static final Comparator<Candidate> ORDER =
                Comparator.comparingLong((Candidate candidate) -> candidate.nearest)
                        .thenComparingInt(candidate -> candidate.x)
                        .thenComparingInt(candidate -> candidate.y)
                        .thenComparingInt(candidate -> candidate.z);

        private final int x;
        private final int y;
        private final int z;
        private final Section section;
        private final long nearest;

        private Candidate(int x, int y, int z, Section section, BlockPos origin) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.section = section;
            if (origin == null) {
                nearest = 0L;
            } else {
                long dx = gap(origin.getX(), x << 4);
                long dy = gap(origin.getY(), y << 4);
                long dz = gap(origin.getZ(), z << 4);
                nearest = dx * dx + dy * dy + dz * dz;
            }
        }

        private static long gap(int coordinate, int sectionMin) {
            if (coordinate < sectionMin) return (long) sectionMin - coordinate;
            return Math.max(0L, (long) coordinate - (sectionMin + 15));
        }

        /** Whether every cell of this section orders after {@code match}. */
        private boolean startsAfter(Match match, BlockPos origin) {
            if (origin != null) return nearest > match.distance;
            if (x << 4 != match.x) return x << 4 > match.x;
            if (y << 4 != match.y) return y << 4 > match.y;
            return z << 4 > match.z;
        }
    }

    private record Match(long distance, int x, int y, int z, Section section, int index) {
        private static final Comparator<Match> ORDER = Comparator.comparingLong(Match::distance)
                .thenComparingInt(Match::x).thenComparingInt(Match::y).thenComparingInt(Match::z);
    }

    public record RegionBounds(BlockPos min, BlockPos max) {
        public RegionBounds {
            min = min.immutable();
            max = max.immutable();
            long sizeX = (long) max.getX() - min.getX() + 1L;
            long sizeY = (long) max.getY() - min.getY() + 1L;
            long sizeZ = (long) max.getZ() - min.getZ() + 1L;
            if (sizeX < 1 || sizeY < 1 || sizeZ < 1) {
                throw new IllegalArgumentException("block region min must not exceed max");
            }
            if (sizeX > MAX_REGION_AXIS || sizeY > MAX_REGION_AXIS || sizeZ > MAX_REGION_AXIS
                    || sizeX * sizeY * sizeZ > MAX_REGION_CELLS) {
                throw new IllegalArgumentException("block region exceeds bounded query limits");
            }
        }

        public static RegionBounds between(BlockPos min, BlockPos max) {
            return new RegionBounds(min, max);
        }

        public BlockPos size() {
            return new BlockPos(max.getX() - min.getX() + 1, max.getY() - min.getY() + 1,
                    max.getZ() - min.getZ() + 1);
        }
    }

    public record LocatedCell(BlockPos position, BlockEvidenceCell cell) {
        public LocatedCell {
            position = position.immutable();
        }
    }

    public record FindResult(List<LocatedCell> matches, boolean hasMore) {
        public FindResult {
            matches = List.copyOf(matches);
        }
    }

    public record RegionResult(BlockPos size, List<LocatedCell> cells, boolean complete) {
        public RegionResult {
            size = size.immutable();
            cells = List.copyOf(cells);
        }
    }
}
