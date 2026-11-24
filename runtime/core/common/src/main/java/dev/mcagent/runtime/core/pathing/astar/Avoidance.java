package dev.mcagent.runtime.core.pathing.astar;

import java.util.ArrayList;
import java.util.List;

import dev.mcagent.runtime.core.pathing.goals.Goal;
import dev.mcagent.runtime.core.pathing.goals.GoalApproachAvoiding;
import dev.mcagent.runtime.core.pathing.goals.GoalAvoidEntities;
import dev.mcagent.runtime.core.pathing.moves.CalculationContext;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.phys.Vec3;

/**
 * Spherical cost penalty source: spheres around mobs (radius 8, coefficient 1.5) and spawners (radius 16,
 * coefficient 2.0) are multiplied into the Favoring table so A* tends to route around them. Controlled by the
 * NavSettings.avoidance switch (off by default; when off, create returns an empty list and behavior is
 * unchanged).
 *
 * <p>Inside a sphere the cost is multiplied by the coefficient: when a node lies inside, actionCost *=
 * coefficient. Overlapping spheres multiply (a cell near both a mob and a spawner is multiplied twice).
 * Spiders in bright daylight are not threats; neither are unprovoked endermen or zombified piglins that have
 * not been attacked.
 */
public final class Avoidance {

    private final int centerX;
    private final int centerY;
    private final int centerZ;
    private final double coefficient;
    private final int radius;
    private final int radiusSq;

    public Avoidance(BlockPos center, double coefficient, int radius) {
        this(center.getX(), center.getY(), center.getZ(), coefficient, radius);
    }

    public Avoidance(int centerX, int centerY, int centerZ, double coefficient, int radius) {
        this.centerX = centerX;
        this.centerY = centerY;
        this.centerZ = centerZ;
        this.coefficient = coefficient;
        this.radius = radius;
        this.radiusSq = radius * radius;
    }

    /** Returns coefficient when (x,y,z) lies inside the sphere, otherwise 1.0. */
    public double coefficient(int x, int y, int z) {
        int dx = x - centerX;
        int dy = y - centerY;
        int dz = z - centerZ;
        return dx * dx + dy * dy + dz * dz <= radiusSq ? coefficient : 1.0D;
    }

    /**
     * <b>The goal decides what to avoid</b>, not a global setting.
     *
     * <p>When the goal carries a threat table ({@code GoalAvoidEntities}), penalty spheres are built from it
     * directly: the position is the entity's true coordinates and the radius is each threat's own
     * ({@code Menace.dangerRadius}, derived from its hitbox). Other goals (mining, following, building) still
     * use the global switch in {@link #create}, which is off by default.
     *
     * <p>This keeps "how far to stay away" defined in exactly one place, and it only takes effect on
     * navigations that actually involve a fight.
     */
    public static List<Avoidance> forGoal(
            Goal goal, ServerPlayer player, CalculationContext context) {
        GoalAvoidEntities field = fieldOf(goal);
        if (field == null) {
            return create(player, context);
        }
        List<Avoidance> res = new ArrayList<>();
        for (GoalAvoidEntities.Threat t : field.threats()) {
            res.add(new Avoidance(
                    (int) Math.floor(t.x()), (int) Math.floor(t.y()), (int) Math.floor(t.z()),
                    IN_DANGER_COEFFICIENT, (int) Math.ceil(t.radius())));   // radius, not arrival distance
        }
        return res;
    }

    /**
     * Cost multiplier for a step inside a mob's danger radius.
     *
     * <p>Calibration: a danger radius is about three blocks, so crossing it takes about three steps, each
     * three times more expensive, roughly equal to a nine-block detour. That is expensive enough to prefer
     * going around a mob over passing through it, but not so expensive that tunneling through a mountain
     * wins.
     *
     * <p>It applies to <b>edge cost</b>, so it can be as large as needed: A* accumulates it per cell and
     * prunes correctly, unlike a heuristic that breaks the search when it grows too large.
     */
    private static final double IN_DANGER_COEFFICIENT = 4.0;

    /** Unwraps the goal to find its threat table; returns null if there is none. */
    private static GoalAvoidEntities fieldOf(Goal goal) {
        if (goal instanceof GoalAvoidEntities g) {
            return g;
        }
        if (goal instanceof GoalApproachAvoiding g) {
            return g.repulsion();
        }
        return null;
    }

    /**
     * Builds all avoidance spheres for this tick. Returns an empty list when NavSettings.avoidance is off;
     * when on, collects mobs and spawners near the player.
     */
    private static List<Avoidance> create(
            ServerPlayer player, CalculationContext context) {
        NavSettings s = NavSettings.get();
        if (!s.avoidance) {
            return List.of();
        }
        List<Avoidance> res = new ArrayList<>();
        double mobSpawnerCoeff = s.mobSpawnerAvoidanceCoefficient;
        double mobCoeff = s.mobAvoidanceCoefficient;
        BlockPos feet = player.blockPosition();
        int mobSpawnerRadius = s.mobSpawnerAvoidanceRadius;
        int mobRadius = s.mobAvoidanceRadius;
        if (mobSpawnerCoeff != 1.0D) {
            if (context != null) {
                res.addAll(blockShapes(context.spawnerAvoidanceCenters, feet,
                        SPAWNER_CHUNK_SCAN_RADIUS * 16,
                        mobSpawnerCoeff, mobSpawnerRadius));
            }
        }
        if (mobCoeff != 1.0D) {
            if (context != null) {
                res.addAll(entityShapes(
                        context.entityAvoidanceCenters, mobCoeff, mobRadius));
            }
        }
        return res;
    }

    /** Build entity-shaped avoidance exclusively from published Entity Knowledge centers. */
    public static List<Avoidance> entityShapes(
            Iterable<Vec3> centers, double coefficient, int avoidanceRadius) {
        List<Avoidance> out = new ArrayList<>();
        for (Vec3 center : centers) {
            out.add(new Avoidance((int) Math.floor(center.x), (int) Math.floor(center.y),
                    (int) Math.floor(center.z), coefficient, avoidanceRadius));
        }
        return List.copyOf(out);
    }

    /** Scan radius in loaded chunks around the player (16 chunks = 256 blocks). */
    private static final int SPAWNER_CHUNK_SCAN_RADIUS = 16;

    /** Build block-shaped avoidance exclusively from published Block Knowledge positions. */
    public static List<Avoidance> blockShapes(
            Iterable<BlockPos> knownSpawners, BlockPos center, int blockRadius,
            double coefficient, int avoidanceRadius) {
        List<Avoidance> out = new ArrayList<>();
        for (BlockPos position : knownSpawners) {
            if (Math.abs(position.getX() - center.getX()) > blockRadius
                    || Math.abs(position.getZ() - center.getZ()) > blockRadius) {
                continue;
            }
            out.add(new Avoidance(position, coefficient, avoidanceRadius));
        }
        return List.copyOf(out);
    }

    /** Multiplies the spherical penalty into the favoring table (existing values times coefficient). */
    public void applySpherical(it.unimi.dsi.fastutil.longs.Long2DoubleOpenHashMap map) {
        for (int x = -radius; x <= radius; x++) {
            for (int y = -radius; y <= radius; y++) {
                for (int z = -radius; z <= radius; z++) {
                    if (x * x + y * y + z * z <= radius * radius) {
                        long hash = PathNode.longHash(centerX + x, centerY + y, centerZ + z);
                        map.put(hash, map.get(hash) * coefficient);
                    }
                }
            }
        }
    }
}
