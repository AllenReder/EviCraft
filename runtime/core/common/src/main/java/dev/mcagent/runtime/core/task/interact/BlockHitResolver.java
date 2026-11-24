package dev.mcagent.runtime.core.task.interact;

import dev.mcagent.runtime.core.act.Interaction;
import dev.mcagent.runtime.entity.InputDriver;
import dev.mcagent.runtime.entity.BotPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.util.Mth;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.VoxelShape;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Resolves one evidence-bound block to a native, visible outline hit. */
final class BlockHitResolver {
    private static final double POINT_INSET = 1.0E-4;
    private static final int MAX_RAYCASTS = 128;

    private BlockHitResolver() {}

    enum Failure {
        OUT_OF_REACH,
        OCCLUDED,
        UNSUPPORTED_SHAPE
    }

    static final class Budget {
        private int raycasts;

        private boolean tryAcquire() {
            if (raycasts == MAX_RAYCASTS) return false;
            raycasts++;
            return true;
        }
    }

    record Resolution(BlockHitResult hit, Failure failure, HitResult blocker, String detail) {
        static Resolution hit(BlockHitResult hit) {
            return new Resolution(hit, null, null, null);
        }

        static Resolution failed(Failure failure, HitResult blocker, String detail) {
            return new Resolution(null, failure, blocker, detail);
        }
    }

    static Resolution resolveTargetHit(BotPlayer player, BlockPos target) {
        return resolve(player, player.level(), target, null, new Budget());
    }

    static Resolution resolveSupportHit(BotPlayer player, BlockGetter blocks, BlockPos support,
                                        Direction requiredFace, Budget budget) {
        return resolve(player, blocks, support, requiredFace, budget);
    }

    private static Resolution resolve(BotPlayer player, BlockGetter blocks, BlockPos target,
                                      Direction requiredFace, Budget budget) {
        VoxelShape shape = blocks.getBlockState(target)
                .getShape(blocks, target, CollisionContext.of(player));
        if (shape.isEmpty()) {
            return Resolution.failed(Failure.UNSUPPORTED_SHAPE, null, "empty_outline");
        }

        Vec3 eye = player.getEyePosition();
        double reach = player.blockInteractionRange();
        double reachSquared = reach * reach;
        List<Candidate> candidates = candidates(eye, shape, target, requiredFace);
        if (candidates.isEmpty()) {
            return Resolution.failed(Failure.UNSUPPORTED_SHAPE, null, "empty_outline");
        }

        float yaw = player.getYRot();
        float pitch = player.getXRot();
        float headYaw = player.getYHeadRot();
        boolean selected = false;
        boolean inRange = false;
        HitResult nearestBlocker = null;
        double nearestBlockerDistance = Double.POSITIVE_INFINITY;
        try {
            for (Candidate candidate : candidates) {
                if (eye.distanceToSqr(candidate.surfacePoint()) > reachSquared) continue;
                inRange = true;
                if (!budget.tryAcquire()) {
                    return Resolution.failed(Failure.UNSUPPORTED_SHAPE, nearestBlocker,
                            "candidate_budget_exhausted");
                }
                InputDriver.lookAt(player, candidate.aimPoint());
                HitResult hit = Interaction.nativeRaytrace(player, reach);
                if (hit instanceof BlockHitResult blockHit
                        && blockHit.getBlockPos().equals(target)
                        && (requiredFace == null
                        || blockHit.getDirection() == requiredFace)) {
                    selected = true;
                    return Resolution.hit(blockHit);
                }
                if (hit.getType() != HitResult.Type.MISS) {
                    double distance = eye.distanceToSqr(hit.getLocation());
                    if (distance < nearestBlockerDistance) {
                        nearestBlocker = hit;
                        nearestBlockerDistance = distance;
                    }
                }
            }
        } finally {
            if (!selected) {
                player.setYRot(yaw);
                player.setXRot(pitch);
                player.setYHeadRot(headYaw);
            }
        }
        if (!inRange) {
            return Resolution.failed(Failure.OUT_OF_REACH, null, null);
        }
        return Resolution.failed(Failure.OCCLUDED, nearestBlocker, null);
    }

    private static List<Candidate> candidates(Vec3 eye, VoxelShape shape, BlockPos target,
                                              Direction requiredFace) {
        Set<Candidate> candidates = new LinkedHashSet<>();
        for (AABB local : shape.toAabbs()) {
            AABB box = local.move(target);
            for (Direction face : Direction.values()) {
                if (requiredFace != null && face != requiredFace) continue;
                Vec3 projected = facePoint(box, face,
                        interiorCoordinate(eye.x, box.minX, box.maxX),
                        interiorCoordinate(eye.y, box.minY, box.maxY),
                        interiorCoordinate(eye.z, box.minZ, box.maxZ));
                candidates.add(candidate(box, face, projected));

                Vec3 center = facePoint(box, face,
                        (box.minX + box.maxX) * 0.5,
                        (box.minY + box.maxY) * 0.5,
                        (box.minZ + box.maxZ) * 0.5);
                candidates.add(candidate(box, face, center));
            }
        }
        List<Candidate> ordered = new ArrayList<>(candidates);
        ordered.sort(Comparator.comparingDouble(candidate ->
                eye.distanceToSqr(candidate.surfacePoint())));
        return ordered;
    }

    private static Candidate candidate(AABB box, Direction face, Vec3 surfacePoint) {
        double normalInset = switch (face.getAxis()) {
            case X -> interiorInset(box.maxX - box.minX);
            case Y -> interiorInset(box.maxY - box.minY);
            case Z -> interiorInset(box.maxZ - box.minZ);
        };
        Vec3 outwardNormal = Vec3.atLowerCornerOf(face.getNormal());
        return new Candidate(surfacePoint,
                surfacePoint.subtract(outwardNormal.scale(normalInset)));
    }

    private static Vec3 facePoint(AABB box, Direction face, double x, double y, double z) {
        return switch (face) {
            case WEST -> new Vec3(box.minX, y, z);
            case EAST -> new Vec3(box.maxX, y, z);
            case DOWN -> new Vec3(x, box.minY, z);
            case UP -> new Vec3(x, box.maxY, z);
            case NORTH -> new Vec3(x, y, box.minZ);
            case SOUTH -> new Vec3(x, y, box.maxZ);
        };
    }

    private static double interiorCoordinate(double value, double minimum, double maximum) {
        double inset = interiorInset(maximum - minimum);
        return Mth.clamp(value, minimum + inset, maximum - inset);
    }

    private static double interiorInset(double size) {
        return Math.min(POINT_INSET, size * 0.25);
    }

    private record Candidate(Vec3 surfacePoint, Vec3 aimPoint) {}
}
