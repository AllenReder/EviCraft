package dev.mcagent.runtime.evidence;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.knowledge.GroundedEvidencePolicy;
import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Eye-origin block sight for grounded evidence.
 *
 * <p>Every tick casts dense rays from the eye through the {@link VisibilityGrid}. A cell enters
 * the frame only when a ray reaches it: air cells a ray passes through, and non-air cells whose
 * outline shape or fluid surface a ray hits. Opaque surfaces end the ray, so nothing behind them
 * is admitted. Rays cover the full sphere, or with a narrower field of view only the cone of that
 * angle around the direction the Actor looks.
 *
 * <p>The schedule is deterministic. One pass is a regular equi-angular cube-map lattice; each
 * pass shifts the lattice by the next point of a low-discrepancy sequence, so passes interleave
 * into ever finer coverage. A tick spends a fixed work budget (cell steps plus a fixed charge per
 * ray) and carries the unfinished pass forward. Once the eye and the sections in view have been
 * still for {@link Settings#settledPasses} passes, a tick casts a single pass.
 *
 * <p>A lattice direction whose last ray, and whose neighbours' last rays, met no block is open
 * sky or open void: it is cast on one pass in {@link #OPEN_INTERVAL}, leaving the budget for
 * directions that have something to show. A direction next to one that met a block keeps its
 * full rate, so terrain coming into view is caught at its edge.
 */
final class GroundedBlockSensor {

    static final int RANGE = 64;

    /** Sections covering the eye cell plus and minus {@link #RANGE} along one axis. */
    private static final int SPAN = 9;
    private static final int SLOTS = SPAN * SPAN * SPAN;
    private static final int RAY_WORK = 2;
    /** Rays cast back to back share sections, so a pass walks the lattice tile by tile. */
    private static final int TILE = 8;
    private static final int OPEN_INTERVAL = 8;
    private static final int SEEN = 1;
    private static final int STOP = 2;
    private static final double JITTER_U = 0.7548776662466927;
    private static final double JITTER_V = 0.5698402909980532;

    private final Settings settings;
    /** Whether sight covers the full sphere, so no direction is tested against the look. */
    private final boolean allDirections;
    /** Cosine of the angle between the look direction and the edge of the field of view. */
    private final double sightCosine;
    private final int cellsPerFace;
    private final int cells;
    /** Lattice direction of each ray of a pass: tiles in scattered order, rows within a tile. */
    private final int[] order;
    private final byte[] cellFace;
    private final short[] cellRow;
    private final short[] cellColumn;
    // Per-pass tables: a ray is aimed without a division, a square root, or a tangent.
    private final double[] tanU;
    private final double[] tanV;
    private final double[] inverseTanU;
    private final double[] inverseTanV;
    /** Ray parameter at {@link #RANGE} blocks, per row and column, for unnormalized directions. */
    private final double[] reachByRowColumn;
    /** Per lattice direction: whether its last ray ended without meeting a block. */
    private final boolean[] open;
    private boolean metBlock;
    /** Whether the last cast ended on an opaque surface or unloaded terrain short of its reach. */
    private boolean stopped;

    private final VisibilityGrid.Masks[] slotMasks = new VisibilityGrid.Masks[SLOTS];
    private final int[] slotResolved = new int[SLOTS];
    private final int[] slotTouched = new int[SLOTS];
    private final long[][] slotAir = new long[SLOTS][];
    private final long[][] slotBlock = new long[SLOTS][];
    private final int[] touched = new int[SLOTS];
    private final BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
    private final Frame frame = new Frame();
    private int touchedCount;
    private int epoch;

    private ServerLevel level;
    private VisibilityGrid grid;
    private long tick;
    private int baseX;
    private int baseY;
    private int baseZ;
    private int minSectionY;
    private int maxSectionY;
    private double originX;
    private double originY;
    private double originZ;
    private int originCellX;
    private int originCellY;
    private int originCellZ;
    private double rayX;
    private double rayY;
    private double rayZ;
    private double inverseX;
    private double inverseY;
    private double inverseZ;
    /** Ray parameter at which the aimed ray has travelled {@link #RANGE} blocks. */
    private double reach;
    private boolean insideOutline;
    private double lookX;
    private double lookY;
    private double lookZ;

    private long pass;
    private int rayInPass;
    private ServerLevel settledLevel;
    private Vec3 settledEye;
    private Vec3 settledLook;
    private long settledChanges;
    private int settledPasses;

    /** @param fieldOfViewDegrees full angle of the cone of sight, from 1 through 360 */
    GroundedBlockSensor(int fieldOfViewDegrees) {
        this(Settings.PRODUCTION, fieldOfViewDegrees);
    }

    GroundedBlockSensor(Settings settings) {
        this(settings, GroundedEvidencePolicy.FULL_FIELD_OF_VIEW_DEGREES);
    }

    private GroundedBlockSensor(Settings settings, int fieldOfViewDegrees) {
        this.settings = settings;
        this.allDirections = fieldOfViewDegrees == GroundedEvidencePolicy.FULL_FIELD_OF_VIEW_DEGREES;
        this.sightCosine = Math.cos(Math.toRadians(fieldOfViewDegrees / 2.0));
        this.cellsPerFace = settings.faceResolution() * settings.faceResolution();
        this.cells = 6 * cellsPerFace;
        int resolution = settings.faceResolution();
        int tilesPerEdge = resolution / TILE;
        int tilesPerFace = tilesPerEdge * tilesPerEdge;
        int tiles = 6 * tilesPerFace;
        long tileStride = coprimeStride(tiles);
        this.order = new int[cells];
        this.cellFace = new byte[cells];
        this.cellRow = new short[cells];
        this.cellColumn = new short[cells];
        for (int ray = 0; ray < cells; ray++) {
            int tile = (int) (ray / (TILE * TILE) * tileStride % tiles);
            int within = ray % (TILE * TILE);
            int column = tile % tilesPerFace % tilesPerEdge * TILE + within % TILE;
            int row = tile % tilesPerFace / tilesPerEdge * TILE + within / TILE;
            int cell = tile / tilesPerFace * cellsPerFace + row * resolution + column;
            order[ray] = cell;
            cellFace[cell] = (byte) (tile / tilesPerFace);
            cellRow[cell] = (short) row;
            cellColumn[cell] = (short) column;
        }
        this.tanU = new double[resolution];
        this.tanV = new double[resolution];
        this.inverseTanU = new double[resolution];
        this.inverseTanV = new double[resolution];
        this.reachByRowColumn = new double[cellsPerFace];
        this.open = new boolean[cells];
    }

    /**
     * @param workBudget cell steps plus two per ray that one tick may spend
     * @param faceResolution lattice points per cube-map face edge in one pass, a multiple of 8
     * @param settledPasses passes cast at full rate before a still scene drops to one pass a tick
     */
    record Settings(int workBudget, int faceResolution, int settledPasses) {
        /**
         * About 20 ms a tick. Many servers running side by side still hold 20 ticks a second with
         * the same tick spacing as servers that do no sight at all. A still scene is refined to
         * about two microsteradians a ray before it settles.
         */
        static final Settings PRODUCTION = new Settings(2_000_000, 32, 1024);

        Settings {
            if (workBudget < 1 || faceResolution < TILE || faceResolution % TILE != 0
                    || settledPasses < 1) {
                throw new IllegalArgumentException("invalid sensor settings");
            }
        }
    }

    Frame sample(BotPlayer bot) {
        level = bot.serverLevel();
        grid = VisibilityGrid.of(level);
        tick = level.getServer().getTickCount();
        grid.evictUnused(tick);
        Vec3 eye = bot.getEyePosition();
        Vec3 look = bot.getLookAngle();
        lookX = look.x;
        lookY = look.y;
        lookZ = look.z;
        begin(eye);
        frame.contact = contact(bot);

        if (level != settledLevel || !eye.equals(settledEye)
                || (!allDirections && !look.equals(settledLook))
                || grid.activeChanges() != settledChanges) {
            settledLevel = level;
            settledEye = eye;
            settledLook = look;
            settledChanges = grid.activeChanges();
            settledPasses = 0;
        }
        boolean settled = settledPasses >= settings.settledPasses();
        int work = 0;
        int rays = 0;
        int passes = 0;
        while (work < settings.workBudget() && !(settled && passes > 0)) {
            if (rayInPass == 0) preparePass();
            int cell = order[rayInPass];
            if (skipsOpen(cell) || !aimsInSight(cell)) {
                work++;
            } else {
                metBlock = false;
                work += RAY_WORK + cast();
                open[cell] = !metBlock;
                rays++;
            }
            if (++rayInPass == cells) {
                rayInPass = 0;
                pass++;
                passes++;
                if (settledPasses < settings.settledPasses()) settledPasses++;
            }
        }
        frame.rays = rays;
        frame.work = work;
        frame.settled = settled;
        return frame;
    }

    /**
     * Whether the eye of the last {@link #sample} sees any of a box's sample points: its centre,
     * the given point, and its eight corners drawn slightly inwards. The rays obey the same
     * rules as block sight and add the cells they cross to that frame.
     */
    boolean sees(AABB box, Vec3 point) {
        if (seesPoint(point.x, point.y, point.z)) return true;
        double centerX = (box.minX + box.maxX) / 2;
        double centerY = (box.minY + box.maxY) / 2;
        double centerZ = (box.minZ + box.maxZ) / 2;
        if (seesPoint(centerX, centerY, centerZ)) return true;
        double reachX = box.getXsize() * 0.45;
        double reachY = box.getYsize() * 0.45;
        double reachZ = box.getZsize() * 0.45;
        for (int corner = 0; corner < 8; corner++) {
            if (seesPoint(centerX + ((corner & 1) == 0 ? -reachX : reachX),
                    centerY + ((corner & 2) == 0 ? -reachY : reachY),
                    centerZ + ((corner & 4) == 0 ? -reachZ : reachZ))) return true;
        }
        return false;
    }

    private boolean seesPoint(double x, double y, double z) {
        rayX = x - originX;
        rayY = y - originY;
        rayZ = z - originZ;
        double distanceSquared = rayX * rayX + rayY * rayY + rayZ * rayZ;
        if (distanceSquared > RANGE * RANGE) return false;
        if (!allDirections && outOfSight(Math.sqrt(distanceSquared))) return false;
        inverseX = rayX == 0 ? Double.POSITIVE_INFINITY : 1.0 / rayX;
        inverseY = rayY == 0 ? Double.POSITIVE_INFINITY : 1.0 / rayY;
        inverseZ = rayZ == 0 ? Double.POSITIVE_INFINITY : 1.0 / rayZ;
        // The direction spans eye to point, so the point lies at ray parameter one.
        reach = 1.0;
        stopped = false;
        cast();
        return !stopped;
    }

    private void begin(Vec3 eye) {
        epoch++;
        touchedCount = 0;
        originX = eye.x;
        originY = eye.y;
        originZ = eye.z;
        originCellX = Mth.floor(eye.x);
        originCellY = Mth.floor(eye.y);
        originCellZ = Mth.floor(eye.z);
        baseX = (originCellX - RANGE) >> 4;
        baseY = (originCellY - RANGE) >> 4;
        baseZ = (originCellZ - RANGE) >> 4;
        minSectionY = level.getMinSection();
        maxSectionY = level.getMaxSection();
    }

    private void preparePass() {
        int resolution = settings.faceResolution();
        double shiftU = fractional(0.5 + pass * JITTER_U);
        double shiftV = fractional(0.5 + pass * JITTER_V);
        for (int index = 0; index < resolution; index++) {
            tanU[index] = Math.tan((-1.0 + 2.0 * (index + shiftU) / resolution) * Math.PI / 4.0);
            tanV[index] = Math.tan((-1.0 + 2.0 * (index + shiftV) / resolution) * Math.PI / 4.0);
            inverseTanU[index] = 1.0 / tanU[index];
            inverseTanV[index] = 1.0 / tanV[index];
        }
        for (int row = 0; row < resolution; row++) {
            for (int column = 0; column < resolution; column++) {
                reachByRowColumn[row * resolution + column] = RANGE / Math.sqrt(
                        1.0 + tanU[column] * tanU[column] + tanV[row] * tanV[row]);
            }
        }
    }

    private boolean skipsOpen(int cell) {
        if (!open[cell] || (pass + cell) % OPEN_INTERVAL == 0) return false;
        int resolution = settings.faceResolution();
        int column = cellColumn[cell];
        int row = cellRow[cell];
        return (column == 0 || open[cell - 1]) && (column == resolution - 1 || open[cell + 1])
                && (row == 0 || open[cell - resolution])
                && (row == resolution - 1 || open[cell + resolution]);
    }

    /** Aim along one lattice direction and tell whether it lies in the field of view. */
    private boolean aimsInSight(int cell) {
        aim(cell);
        // The aimed direction reaches RANGE blocks at parameter reach, so its length is their ratio.
        return allDirections || !outOfSight(RANGE / reach);
    }

    /** Whether the aimed ray, of the given length, points outside the cone of sight. */
    private boolean outOfSight(double length) {
        return rayX * lookX + rayY * lookY + rayZ * lookZ < sightCosine * length;
    }

    /** Aim along one lattice direction; the direction keeps its cube-map length, at least one. */
    private void aim(int cell) {
        int column = cellColumn[cell];
        int row = cellRow[cell];
        double u = tanU[column];
        double v = tanV[row];
        double inverseU = inverseTanU[column];
        double inverseV = inverseTanV[row];
        switch (cellFace[cell]) {
            case 0 -> {
                rayX = 1; rayY = v; rayZ = -u;
                inverseX = 1; inverseY = inverseV; inverseZ = -inverseU;
            }
            case 1 -> {
                rayX = -1; rayY = v; rayZ = u;
                inverseX = -1; inverseY = inverseV; inverseZ = inverseU;
            }
            case 2 -> {
                rayX = u; rayY = 1; rayZ = -v;
                inverseX = inverseU; inverseY = 1; inverseZ = -inverseV;
            }
            case 3 -> {
                rayX = u; rayY = -1; rayZ = v;
                inverseX = inverseU; inverseY = -1; inverseZ = inverseV;
            }
            case 4 -> {
                rayX = u; rayY = v; rayZ = 1;
                inverseX = inverseU; inverseY = inverseV; inverseZ = 1;
            }
            default -> {
                rayX = -u; rayY = v; rayZ = -1;
                inverseX = -inverseU; inverseY = inverseV; inverseZ = -1;
            }
        }
        reach = reachByRowColumn[row * settings.faceResolution() + column];
    }

    /** Walk the aimed ray cell by cell and return the number of cells visited. */
    private int cast() {
        int x = originCellX;
        int y = originCellY;
        int z = originCellZ;
        int stepX = rayX > 0 ? 1 : rayX < 0 ? -1 : 0;
        int stepY = rayY > 0 ? 1 : rayY < 0 ? -1 : 0;
        int stepZ = rayZ > 0 ? 1 : rayZ < 0 ? -1 : 0;
        double deltaX = Math.abs(inverseX);
        double deltaY = Math.abs(inverseY);
        double deltaZ = Math.abs(inverseZ);
        double nextX = stepX == 0 ? Double.POSITIVE_INFINITY
                : ((stepX > 0 ? x + 1 : x) - originX) * inverseX;
        double nextY = stepY == 0 ? Double.POSITIVE_INFINITY
                : ((stepY > 0 ? y + 1 : y) - originY) * inverseY;
        double nextZ = stepZ == 0 ? Double.POSITIVE_INFINITY
                : ((stepZ > 0 ? z + 1 : z) - originZ) * inverseZ;
        VisibilityGrid.Masks masks = null;
        long[] air = null;
        long[] opaque = null;
        long[] water = null;
        long[] seenAir = null;
        long[] seenBlock = null;
        boolean enterSection = true;
        int steps = 0;
        while (true) {
            if (enterSection) {
                int slot = slot(x >> 4, y >> 4, z >> 4);
                if (slot < 0) {
                    stopped = true;
                    return steps;
                }
                masks = slotMasks[slot];
                air = masks.air;
                opaque = masks.opaque;
                water = masks.water;
                seenAir = slotAir[slot];
                seenBlock = slotBlock[slot];
                enterSection = false;
            }
            steps++;
            int index = (x & 15) | (z & 15) << 4 | (y & 15) << 8;
            int word = index >>> 6;
            long bit = 1L << index;
            if ((air[word] & bit) != 0) {
                seenAir[word] |= bit;
            } else if ((opaque[word] & bit) != 0) {
                seenBlock[word] |= bit;
                metBlock = true;
                stopped = true;
                return steps;
            } else if ((water[word] & bit) != 0 && (y & 15) != 15
                    && (water[(index + 256) >>> 6] & 1L << (index + 256)) != 0) {
                // Water under water fills its cell, so every ray entering the cell meets it.
                seenBlock[word] |= bit;
                metBlock = true;
            } else {
                int outcome = visitShaped(masks.section, x, y, z);
                if ((outcome & SEEN) != 0) {
                    seenBlock[word] |= bit;
                    metBlock = true;
                }
                if ((outcome & STOP) != 0) {
                    stopped = true;
                    return steps;
                }
            }
            double entered;
            if (nextX < nextY) {
                if (nextX < nextZ) {
                    entered = nextX;
                    nextX += deltaX;
                    x += stepX;
                    enterSection = ((x ^ (x - stepX)) & ~15) != 0;
                } else {
                    entered = nextZ;
                    nextZ += deltaZ;
                    z += stepZ;
                    enterSection = ((z ^ (z - stepZ)) & ~15) != 0;
                }
            } else if (nextY < nextZ) {
                entered = nextY;
                nextY += deltaY;
                y += stepY;
                enterSection = ((y ^ (y - stepY)) & ~15) != 0;
            } else {
                entered = nextZ;
                nextZ += deltaZ;
                z += stepZ;
                enterSection = ((z ^ (z - stepZ)) & ~15) != 0;
            }
            if (entered > reach) return steps;
        }
    }

    /** Slot of a loaded section with its frame bit sets ready, or -1 where the ray must end. */
    private int slot(int sectionX, int sectionY, int sectionZ) {
        int localX = sectionX - baseX;
        int localY = sectionY - baseY;
        int localZ = sectionZ - baseZ;
        if (localX < 0 || localX >= SPAN || localY < 0 || localY >= SPAN
                || localZ < 0 || localZ >= SPAN) return -1;
        int slot = (localY * SPAN + localZ) * SPAN + localX;
        if (slotResolved[slot] != epoch) {
            slotResolved[slot] = epoch;
            slotMasks[slot] = resolve(sectionX, sectionY, sectionZ);
        }
        if (slotMasks[slot] == null) return -1;
        if (slotTouched[slot] != epoch) {
            slotTouched[slot] = epoch;
            if (slotAir[slot] == null) {
                slotAir[slot] = new long[64];
                slotBlock[slot] = new long[64];
            } else {
                Arrays.fill(slotAir[slot], 0L);
                Arrays.fill(slotBlock[slot], 0L);
            }
            touched[touchedCount++] = slot;
        }
        return slot;
    }

    /** Sight never loads or generates terrain: an unloaded section ends the ray. */
    private VisibilityGrid.Masks resolve(int sectionX, int sectionY, int sectionZ) {
        if (sectionY < minSectionY || sectionY >= maxSectionY) return null;
        LevelChunk chunk = level.getChunkSource().getChunkNow(sectionX, sectionZ);
        if (chunk == null) return null;
        LevelChunkSection section = chunk.getSection(chunk.getSectionIndexFromSectionY(sectionY));
        return grid.masks(section, SectionPos.asLong(sectionX, sectionY, sectionZ), tick);
    }

    /** Exact test of the aimed ray against one cell's outline shape and fluid surface. */
    private int visitShaped(LevelChunkSection section, int x, int y, int z) {
        BlockState state = section.getBlockState(x & 15, y & 15, z & 15);
        FluidState fluid = state.getFluidState();
        if (state.isAir() && fluid.isEmpty()) return 0;
        BlockVisibility.Outline outline = BlockVisibility.outline(state);
        boolean blockHit = false;
        boolean inside = false;
        if (outline.live) {
            cursor.set(x, y, z);
            Vec3 start = new Vec3(originX, originY, originZ);
            Vec3 end = new Vec3(originX + rayX * reach, originY + rayY * reach,
                    originZ + rayZ * reach);
            BlockHitResult hit = state.getShape(level, cursor, CollisionContext.empty())
                    .clip(start, end, cursor);
            blockHit = hit != null;
            inside = hit != null && hit.isInside();
        } else if (outline.boxes.length > 0) {
            double cellX = x;
            double cellY = y;
            double cellZ = z;
            if (outline.offset) {
                Vec3 offset = state.getOffset(level, cursor.set(x, y, z));
                cellX += offset.x;
                cellY += offset.y;
                cellZ += offset.z;
            }
            double[] boxes = outline.boxes;
            for (int at = 0; at < boxes.length; at += 6) {
                if (hitsBox(cellX + boxes[at], cellY + boxes[at + 1], cellZ + boxes[at + 2],
                        cellX + boxes[at + 3], cellY + boxes[at + 4], cellZ + boxes[at + 5])) {
                    blockHit = true;
                    inside |= insideOutline;
                }
            }
        }
        boolean fluidHit = false;
        if (!fluid.isEmpty()) {
            double height = sameFluidAbove(fluid, x, y + 1, z) ? 1.0 : fluid.getOwnHeight();
            fluidHit = hitsBox(x, y, z, x + 1.0, y + height, z + 1.0);
        }
        if (!blockHit && !fluidHit) return 0;
        // An outline around the eye itself, such as a cobweb or a portal, does not blind the Actor.
        boolean stop = blockHit && !outline.transparent && !inside
                || fluidHit && !VanillaVisibilityTransparency.fluid(fluid);
        return stop ? SEEN | STOP : SEEN;
    }

    private boolean sameFluidAbove(FluidState fluid, int x, int y, int z) {
        int sectionY = y >> 4;
        if (sectionY < minSectionY || sectionY >= maxSectionY) return false;
        LevelChunk chunk = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
        return chunk != null && chunk.getFluidState(x, y, z).getType().isSame(fluid.getType());
    }

    /** Slab test of the aimed ray, limited to its reach, against one box. */
    private boolean hitsBox(double minX, double minY, double minZ,
                            double maxX, double maxY, double maxZ) {
        double near = Double.NEGATIVE_INFINITY;
        double far = Double.POSITIVE_INFINITY;
        if (rayX != 0) {
            double first = (minX - originX) * inverseX;
            double second = (maxX - originX) * inverseX;
            near = Math.max(near, Math.min(first, second));
            far = Math.min(far, Math.max(first, second));
        } else if (originX < minX || originX > maxX) {
            return false;
        }
        if (rayY != 0) {
            double first = (minY - originY) * inverseY;
            double second = (maxY - originY) * inverseY;
            near = Math.max(near, Math.min(first, second));
            far = Math.min(far, Math.max(first, second));
        } else if (originY < minY || originY > maxY) {
            return false;
        }
        if (rayZ != 0) {
            double first = (minZ - originZ) * inverseZ;
            double second = (maxZ - originZ) * inverseZ;
            near = Math.max(near, Math.min(first, second));
            far = Math.min(far, Math.max(first, second));
        } else if (originZ < minZ || originZ > maxZ) {
            return false;
        }
        if (near > far || far < 0 || near > reach) return false;
        insideOutline = near <= 0;
        return true;
    }

    /** Blocks whose collision shape touches the body are felt, not seen. */
    private List<BlockObservation> contact(BotPlayer bot) {
        List<BlockObservation> observations = new ArrayList<>();
        AABB body = bot.getBoundingBox().inflate(1.0E-6);
        int minX = Mth.floor(body.minX);
        int minY = Mth.floor(body.minY);
        int minZ = Mth.floor(body.minZ);
        int maxX = Mth.floor(body.maxX);
        int maxY = Mth.floor(body.maxY);
        int maxZ = Mth.floor(body.maxZ);
        for (int y = minY; y <= maxY; y++) {
            if (y < level.getMinBuildHeight() || y >= level.getMaxBuildHeight()) continue;
            for (int z = minZ; z <= maxZ; z++) {
                for (int x = minX; x <= maxX; x++) {
                    LevelChunk chunk = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
                    if (chunk == null) continue;
                    BlockPos position = new BlockPos(x, y, z);
                    BlockState state = chunk.getBlockState(position);
                    boolean touching = state.getCollisionShape(chunk, position,
                                    CollisionContext.of(bot))
                            .toAabbs().stream()
                            .map(box -> box.move(position.getX(), position.getY(), position.getZ()))
                            .anyMatch(body::intersects);
                    if (!touching) continue;
                    observations.add(BlockObservation.of(
                            position, state, BlockEvidenceSource.CONTACT));
                }
            }
        }
        return observations;
    }

    private static long coprimeStride(int count) {
        long stride = Math.max(1L, Math.round(count * 0.6180339887498949));
        while (gcd(stride, count) != 1) stride++;
        return stride;
    }

    private static long gcd(long left, long right) {
        while (right != 0) {
            long remainder = left % right;
            left = right;
            right = remainder;
        }
        return left;
    }

    private static double fractional(double value) {
        return value - Math.floor(value);
    }

    /** The cells seen this tick. Reused by the next {@link #sample}. */
    final class Frame implements SightFrame {
        private List<BlockObservation> contact = List.of();
        private int rays;
        private int work;
        private boolean settled;

        List<BlockObservation> contact() {
            return contact;
        }

        int rays() {
            return rays;
        }

        int work() {
            return work;
        }

        boolean settled() {
            return settled;
        }

        @Override
        public int sectionCount() {
            return touchedCount;
        }

        @Override
        public int sectionX(int section) {
            return baseX + touched[section] % SPAN;
        }

        @Override
        public int sectionY(int section) {
            return baseY + touched[section] / (SPAN * SPAN);
        }

        @Override
        public int sectionZ(int section) {
            return baseZ + touched[section] / SPAN % SPAN;
        }

        @Override
        public long[] air(int section) {
            return slotAir[touched[section]];
        }

        @Override
        public long[] block(int section) {
            return slotBlock[touched[section]];
        }

        @Override
        public BlockState state(int section, int localIndex) {
            return slotMasks[touched[section]].section.getBlockState(
                    localIndex & 15, localIndex >>> 8, (localIndex >>> 4) & 15);
        }
    }
}
