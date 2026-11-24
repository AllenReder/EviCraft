package dev.mcagent.runtime.core.pathing.moves;

import dev.mcagent.runtime.core.pathing.execute.AimProcessor;
import dev.mcagent.runtime.core.pathing.settings.NavSettings;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.BaseFireBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;

/**
 * Heading geometry: aim point solving, view rays, heading angles, and the inputs for "walk towards a
 * block". These answer "where should the eyes look and the body face" rather than "is this cell
 * walkable", and are shared across packages by the execution layer ({@code ExecHarness}/
 * {@code PathExecutor}), mining ({@code BlockDigger}) and build playback, so they live apart from the
 * block predicates in {@code MovementHelper}.
 */
public final class AimGeometry {

    private AimGeometry() {}

    /** Center point of a block. */
    public static Vec3 blockCenter(BlockPos pos) {
        return new Vec3(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
    }

    /**
     * First aim point on this block that the eyes can actually hit; null if all are occluded.
     * Order of checks:
     * <ol>
     *   <li>The ray along the current actual rotation already hits the block: keep the gaze and return
     *       the hit point (no re-centering while already looking at it, avoiding needless head turns);</li>
     *   <li>Try the collision-shape center and the six face centers in turn: for each candidate compute
     *       the ideal rotation, quantize it by the rotation step into "the rotation actually reachable
     *       this tick", and cast along that rotation. Only a hit on the block counts as reachable (a tick
     *       that has not finished turning is not misjudged as visible).</li>
     * </ol>
     * Reach distance is {@link NavSettings#blockReachDistance}.
     */
    public static Vec3 reachableAimPoint(net.minecraft.server.level.ServerPlayer player, BlockGetter level, BlockPos pos) {
        Vec3 eye = player.getEyePosition();
        double reach = blockReachDistance(player);
        var state = level.getBlockState(pos);
        boolean fire = state.getBlock() instanceof BaseFireBlock;
        // Already-looking shortcut: keep only if the ray along the current rotation hits exactly this block
        BlockHitResult looking = clipAlongRotation(player, level, player.getYRot(), player.getXRot(), reach);
        if (looking.getType() == HitResult.Type.BLOCK && looking.getBlockPos().equals(pos)) {
            return looking.getLocation();
        }
        // First choice is the center: collision-shape midpoint (full-block center without collision);
        // for fire use the bottom height (extinguishing aims at the base of the fire). Face centers use
        // the outline shape, since the ray test also uses the outline.
        Vec3 center = collisionCenter(level, pos, state);
        VoxelShape outline = state.getShape(level, pos);
        if (outline.isEmpty()) {
            outline = Shapes.block();
        }
        Vec3[] aims = {
                center,
                shapePoint(pos, outline, 0.5, 0.0, 0.5),
                shapePoint(pos, outline, 0.5, 1.0, 0.5),
                shapePoint(pos, outline, 0.5, 0.5, 0.0),
                shapePoint(pos, outline, 0.5, 0.5, 1.0),
                shapePoint(pos, outline, 0.0, 0.5, 0.5),
                shapePoint(pos, outline, 1.0, 0.5, 0.5),
        };
        var aim = new AimProcessor();
        for (Vec3 aimPoint : aims) {
            Vec3 dir = aimPoint.subtract(eye);
            if (dir.lengthSqr() < 1.0e-8) {
                continue;
            }
            // Cast along the rotation actually reachable this tick; if reachable, return the candidate
            // itself (the caller uses it as the rotation target and converges on it in later ticks)
            var stepped = aim.step(player.getYRot(), player.getXRot(),
                    yawTo(eye, aimPoint), pitchTo(eye, aimPoint));
            BlockHitResult res = clipAlongRotation(player, level, stepped.yaw(), stepped.pitch(), reach);
            if (hitsTarget(res, pos, fire)) {
                return aimPoint;
            }
        }
        return null;
    }

    /** Hit test: hits this block; for fire, hitting the supporting block below also counts (thin outline). */
    private static boolean hitsTarget(BlockHitResult res, BlockPos pos, boolean fire) {
        if (res.getType() != HitResult.Type.BLOCK) {
            return false;
        }
        return res.getBlockPos().equals(pos) || (fire && res.getBlockPos().equals(pos.below()));
    }

    /** Collision-shape midpoint; full-block center without collision; for fire, y at the block bottom (its base). */
    public static Vec3 collisionCenter(BlockGetter level, BlockPos pos, BlockState state) {
        VoxelShape shape = state.getCollisionShape(level, pos);
        if (shape.isEmpty()) {
            return new Vec3(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
        }
        double x = (shape.min(net.minecraft.core.Direction.Axis.X) + shape.max(net.minecraft.core.Direction.Axis.X)) / 2;
        double y = (shape.min(net.minecraft.core.Direction.Axis.Y) + shape.max(net.minecraft.core.Direction.Axis.Y)) / 2;
        double z = (shape.min(net.minecraft.core.Direction.Axis.Z) + shape.max(net.minecraft.core.Direction.Axis.Z)) / 2;
        if (state.getBlock() instanceof BaseFireBlock) {
            y = 0;
        }
        return new Vec3(pos.getX() + x, pos.getY() + y, pos.getZ() + z);
    }

    /** Block reach distance: 5.0 in creative, otherwise from settings (default 4.5). */
    public static double blockReachDistance(net.minecraft.server.level.ServerPlayer player) {
        return player.isCreative() ? 5.0 : NavSettings.get().blockReachDistance;
    }

    /** Outline ray from the eye along the given yaw/pitch (ignores fluids); direction uses vanilla float trig. */
    private static BlockHitResult clipAlongRotation(net.minecraft.server.level.ServerPlayer player, BlockGetter level,
                                                    float yaw, float pitch, double reach) {
        Vec3 eye = player.getEyePosition();
        float f = pitch * ((float) Math.PI / 180F);
        float g = -yaw * ((float) Math.PI / 180F);
        float h = net.minecraft.util.Mth.cos(g);
        float i = net.minecraft.util.Mth.sin(g);
        float j = net.minecraft.util.Mth.cos(f);
        float k = net.minecraft.util.Mth.sin(f);
        Vec3 dir = new Vec3(i * j, -k, h * j);
        Vec3 end = eye.add(dir.scale(reach));
        return level.clip(new net.minecraft.world.level.ClipContext(
                eye, end, net.minecraft.world.level.ClipContext.Block.OUTLINE,
                net.minecraft.world.level.ClipContext.Fluid.NONE, player));
    }

    /** Point on a block shape by ratio (each m is the per-axis min/max interpolation factor). */
    static Vec3 shapePoint(BlockPos pos, VoxelShape shape, double mx, double my, double mz) {
        double x = shape.min(net.minecraft.core.Direction.Axis.X) * mx
                + shape.max(net.minecraft.core.Direction.Axis.X) * (1 - mx);
        double y = shape.min(net.minecraft.core.Direction.Axis.Y) * my
                + shape.max(net.minecraft.core.Direction.Axis.Y) * (1 - my);
        double z = shape.min(net.minecraft.core.Direction.Axis.Z) * mz
                + shape.max(net.minecraft.core.Direction.Axis.Z) * (1 - mz);
        return new Vec3(pos.getX() + x, pos.getY() + y, pos.getZ() + z);
    }

    /** Yaw from {@code from} looking at {@code to} (degrees, MC convention; Mth.atan2 approximation). */
    public static float yawTo(Vec3 from, Vec3 to) {
        double dx = from.x - to.x;
        double dz = from.z - to.z;
        return (float) Math.toDegrees(net.minecraft.util.Mth.atan2(dx, -dz));
    }

    /** Pitch from {@code from} looking at {@code to} (degrees, down is positive; Mth.atan2 approximation). */
    public static float pitchTo(Vec3 from, Vec3 to) {
        double dx = from.x - to.x;
        double dy = from.y - to.y;
        double dz = from.z - to.z;
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        return (float) Math.toDegrees(net.minecraft.util.Mth.atan2(dy, horizontal));
    }

    /**
     * Walk towards the target block: yaw at the block center, pitch unchanged (no forced head turn), and
     * hold forward.
     */
    public static void moveTowards(Player player, MovementState state, BlockPos pos) {
        float yaw = yawTo(player.getEyePosition(), blockCenter(pos));
        state.setTarget(new MovementState.MovementTarget(yaw, player.getXRot(), false));
        state.setInput(Input.MOVE_FORWARD, true);
    }
}
