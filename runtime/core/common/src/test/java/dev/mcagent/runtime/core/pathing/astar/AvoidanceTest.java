package dev.mcagent.runtime.core.pathing.astar;

import java.util.List;

import dev.mcagent.runtime.core.pathing.goals.GoalApproachAvoiding;
import dev.mcagent.runtime.core.pathing.goals.GoalAvoidEntities;
import dev.mcagent.runtime.core.pathing.goals.GoalBlock;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Pure-logic pins for the spherical Avoidance penalty: the coefficient applies only inside the sphere,
 * boundary points count as inside, applySpherical multiplies onto existing values, and create returns an
 * empty table when avoidance is off. Penalty spheres come from <b>the goal's own threat table</b>, each
 * threat with its own danger radius.
 */
class AvoidanceTest {

    @Test
    void coefficientInsideSphereOnly() {
        Avoidance a = new Avoidance(0, 64, 0, 1.5, 8);
        // Center
        assertEquals(1.5, a.coefficient(0, 64, 0), 1e-9);
        // Boundary point (distance squared exactly 64)
        assertEquals(1.5, a.coefficient(8, 64, 0), 1e-9);
        // Outside the sphere
        assertEquals(1.0, a.coefficient(9, 64, 0), 1e-9);
        // Applies along y too
        assertEquals(1.5, a.coefficient(0, 72, 0), 1e-9);
        assertEquals(1.0, a.coefficient(0, 73, 0), 1e-9);
    }

    @Test
    void applySphericalMultipliesExistingValue() {
        it.unimi.dsi.fastutil.longs.Long2DoubleOpenHashMap map =
                new it.unimi.dsi.fastutil.longs.Long2DoubleOpenHashMap();
        map.defaultReturnValue(1.0D);
        // Preset a backtrack discount of 0.5 at (0,64,0)
        map.put(PathNode.longHash(0, 64, 0), 0.5);
        Avoidance mob = new Avoidance(0, 64, 0, 1.5, 4);
        mob.applySpherical(map);
        // Inside the sphere at (0,64,0): 0.5 * 1.5 = 0.75
        assertEquals(0.75, map.get(PathNode.longHash(0, 64, 0)), 1e-9);
        // Outside the sphere: default 1.0 (never written)
        assertEquals(1.0, map.get(PathNode.longHash(10, 64, 0)), 1e-9);
    }

    @Test
    void multipleSpheresOverlapMultiply() {
        it.unimi.dsi.fastutil.longs.Long2DoubleOpenHashMap map =
                new it.unimi.dsi.fastutil.longs.Long2DoubleOpenHashMap();
        map.defaultReturnValue(1.0D);
        Avoidance mob = new Avoidance(0, 64, 0, 1.5, 8);
        Avoidance spawner = new Avoidance(0, 64, 0, 2.0, 16);
        mob.applySpherical(map);
        spawner.applySpherical(map);
        // Shared center: 1.0 * 1.5 * 2.0 = 3.0
        assertEquals(3.0, map.get(PathNode.longHash(0, 64, 0)), 1e-9);
        // Only inside the spawner sphere (distance 12, beyond the mob radius 8): 1.0 * 2.0 = 2.0
        assertEquals(2.0, map.get(PathNode.longHash(12, 64, 0)), 1e-9);
        // Outside both spheres: 1.0
        assertEquals(1.0, map.get(PathNode.longHash(20, 64, 0)), 1e-9);
    }

    @Test
    void createReturnsEmptyWhenAvoidanceDisabled() {
        dev.mcagent.runtime.core.pathing.settings.NavSettings s =
                dev.mcagent.runtime.core.pathing.settings.NavSettings.get();
        boolean saved = s.avoidance;
        s.avoidance = false;
        try {
            List<Avoidance> res = Avoidance.forGoal(null, null, null);
            assertTrue(res.isEmpty(), "should return an empty table when avoidance is off");
        } finally {
            s.avoidance = saved;
        }
    }

    @Test
    void blockShapedAvoidanceUsesOnlyTheImmutablePlanningView() {
        BlockPos knownSpawner = new BlockPos(3, 64, 4);
        List<Avoidance> avoidances = Avoidance.blockShapes(
                List.of(knownSpawner, new BlockPos(20, 64, 0)),
                new BlockPos(0, 64, 0), 8, 2.0D, 16);

        assertEquals(1, avoidances.size());
        assertEquals(2.0D, avoidances.getFirst().coefficient(3, 64, 4));
    }

    @Test
    void entityAvoidanceUsesPublishedEntityKnowledgeCenters() {
        List<Avoidance> avoidances = Avoidance.entityShapes(
                List.of(new Vec3(3.75, 64.0, 4.25)), 1.5D, 8);

        assertEquals(1, avoidances.size());
        assertEquals(1.5D, avoidances.getFirst().coefficient(3, 64, 4));
    }

    // ==================== Penalty spheres come from the goal's own threat table ====================

    private static GoalAvoidEntities.Threat threat(double x, double z, double radius) {
        return new GoalAvoidEntities.Threat(x, 64.0, z, radius);
    }

    /** The threat table lives in GoalAvoidEntities and is recognized directly. */
    @Test
    void aBareFieldIsRecognised() {
        var field = new GoalAvoidEntities(40.0, threat(0, 0, 3.0), threat(9, 0, 6.0));
        assertEquals(2, Avoidance.forGoal(field, null, null).size());
    }

    /**
     * Also recognized when wrapped in a stance goal. The stance heuristic is pure distance, so avoidance
     * relies entirely on this edge-cost layer.
     */
    @Test
    void theFieldInsideAStandoffGoalIsRecognised() {
        var wrapped = new GoalApproachAvoiding(new GoalBlock(10, 64, 0),
                new GoalAvoidEntities(40.0, threat(0, 0, 3.0)));
        assertEquals(1, Avoidance.forGoal(wrapped, null, null).size());
    }

    /**
     * Each threat uses <b>its own</b> danger radius. A single shared radius would have to be the maximum,
     * so the Bot would keep a lit creeper's distance from a zombie; the minimum would not stop explosives.
     */
    @Test
    void eachThreatKeepsItsOwnRadius() {
        var field = new GoalAvoidEntities(40.0, threat(0, 0, 2.73), threat(20, 0, 6.71));
        var spheres = Avoidance.forGoal(field, null, null);
        assertTrue(spheres.get(0).coefficient(2, 64, 0) > 1.0);    // Zombie: costly within 3 blocks
        assertEquals(1.0, spheres.get(0).coefficient(4, 64, 0));   // Not costly beyond 3 blocks
        assertTrue(spheres.get(1).coefficient(26, 64, 0) > 1.0);   // Creeper: still costly at 6 blocks
    }
}
