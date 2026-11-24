package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.core.pathing.calc.NavGoal;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.VoxelShape;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.function.Predicate;

/** Freezes the bounded Feet Cells eligible for exact block-hit verification. */
public final class InteractionPoseCandidates {

    private InteractionPoseCandidates() {}

    public static List<BlockPos> freeze(
            BlockPos target,
            BlockPos originFeet,
            double reach,
            double eyeHeight,
            VoxelShape targetOutline,
            Predicate<BlockPos> standable) {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(originFeet, "originFeet");
        Objects.requireNonNull(targetOutline, "targetOutline");
        Objects.requireNonNull(standable, "standable");
        if (!(reach > 0.0) || targetOutline.isEmpty()) return List.of();

        List<AABB> outline = targetOutline.toAabbs().stream()
                .map(box -> box.move(target))
                .toList();
        AABB bounds = outline.stream().reduce(AABB::minmax).orElseThrow();
        int minX = (int) Math.floor(bounds.minX - reach - 0.5);
        int maxX = (int) Math.ceil(bounds.maxX + reach - 0.5);
        int minY = (int) Math.floor(bounds.minY - reach - eyeHeight);
        int maxY = (int) Math.ceil(bounds.maxY + reach - eyeHeight);
        int minZ = (int) Math.floor(bounds.minZ - reach - 0.5);
        int maxZ = (int) Math.ceil(bounds.maxZ + reach - 0.5);
        double reachSquared = reach * reach;

        List<BlockPos> candidates = new ArrayList<>();
        for (int x = minX; x <= maxX; x++) {
            for (int y = minY; y <= maxY; y++) {
                for (int z = minZ; z <= maxZ; z++) {
                    BlockPos feet = new BlockPos(x, y, z);
                    if (!standable.test(feet)) continue;
                    Vec3 eye = new Vec3(x + 0.5, y + eyeHeight, z + 0.5);
                    if (outline.stream().anyMatch(box -> distanceToSqr(eye, box) <= reachSquared)) {
                        candidates.add(feet);
                    }
                }
            }
        }

        candidates.sort(Comparator
                .comparingDouble((BlockPos candidate) ->
                        NavGoal.exact(candidate).heuristic(originFeet))
                .thenComparing(NavGoal.STABLE_COORDINATE_ORDER));
        return List.copyOf(candidates);
    }

    /**
     * Face-adjacent Feet Cells from which a buried target's face would be in plain view once
     * the cells are dug out: the four sides with the target at feet or head height, standing
     * on it, and standing under it. {@code floorSupports} must accept a cell's known floor and
     * {@code enterable} its feet and head cells (open or breakable), so route BREAK can reach it.
     */
    public static List<BlockPos> excavation(
            BlockPos target,
            BlockPos originFeet,
            Predicate<BlockPos> floorSupports,
            Predicate<BlockPos> enterable) {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(originFeet, "originFeet");
        List<BlockPos> poses = new ArrayList<>();
        for (net.minecraft.core.Direction side : net.minecraft.core.Direction.Plane.HORIZONTAL) {
            poses.add(target.relative(side));
            poses.add(target.relative(side).below());
        }
        poses.add(target.above());
        poses.add(target.below(2));
        List<BlockPos> candidates = new ArrayList<>();
        for (BlockPos feet : poses) {
            if (feet.equals(originFeet)) continue;
            if (feet.equals(target) || feet.above().equals(target)) continue;
            if (!floorSupports.test(feet.below())) continue;
            if (!enterable.test(feet) || !enterable.test(feet.above())) continue;
            candidates.add(feet);
        }
        candidates.sort(Comparator
                .comparingDouble((BlockPos candidate) ->
                        NavGoal.exact(candidate).heuristic(originFeet))
                .thenComparing(NavGoal.STABLE_COORDINATE_ORDER));
        return List.copyOf(candidates);
    }

    private static double distanceToSqr(Vec3 point, AABB box) {
        double dx = Math.max(Math.max(box.minX - point.x, 0.0), point.x - box.maxX);
        double dy = Math.max(Math.max(box.minY - point.y, 0.0), point.y - box.maxY);
        double dz = Math.max(Math.max(box.minZ - point.z, 0.0), point.z - box.maxZ);
        return dx * dx + dy * dy + dz * dz;
    }
}
