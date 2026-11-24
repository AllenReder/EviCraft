package dev.mcagent.runtime.core.pathing.execute;

/**
 * View-step quantizer: the view approaches its target in quantized mouse pixels instead of snapping.
 *
 * <p>One step: angle delta → integer pixels at the current sensitivity (rounded) → back to an angle
 * added to the current view. A large delta is mostly covered within one tick, but the result always
 * lies on the pixel grid: once the residual is under half a pixel, the pixel count rounds to 0 and
 * the view stops there. So "is aimed" must be decided by a ray test against the actual view, never
 * by angle equality.
 *
 * <p>When pitch is unspecified (target pitch equals current pitch, i.e. only yaw matters), the pitch
 * returns toward the resting range [-20°, 10°] by 1° per tick.
 *
 * <p>Random view jitter is not reproduced (it serves client-side anti-cheat; a server NPC does not
 * need it).
 *
 * <p>Pure math, no MC dependency; unit-testable in isolation.
 */
public final class AimProcessor {

    /** Lower bound of the resting pitch range (look up at most 20°). */
    public static final float PITCH_LEVEL_MIN = -20.0f;
    /** Upper bound of the resting pitch range (look down at most 10°). */
    public static final float PITCH_LEVEL_MAX = 10.0f;

    /** Mouse sensitivity (0–1); sets the pixel-grid granularity. At 0.5, one pixel = 0.15°. */
    private final double sensitivity;

    public AimProcessor() {
        this(0.5);
    }

    public AimProcessor(double sensitivity) {
        this.sensitivity = sensitivity;
    }

    /** View resulting from one step. */
    public record Rotation(float yaw, float pitch) {}

    /**
     * Steps one tick from the current view toward the target view. The yaw delta is not normalized:
     * the raw delta accumulates, the view field may drift out of range, and only angle comparisons
     * take the short arc. Pitch is clamped to [-90, 90] after stepping. A target pitch equal to the
     * current pitch counts as unspecified and triggers the return-to-level logic.
     */
    public Rotation step(float currentYaw, float currentPitch, float desiredYaw, float desiredPitch) {
        if (desiredPitch == currentPitch) {
            desiredPitch = nudgeToLevel(desiredPitch);
        }
        float yaw = currentYaw + stepAngle(desiredYaw - currentYaw);
        float pitch = clampPitch(currentPitch + stepAngle(desiredPitch - currentPitch));
        return new Rotation(yaw, pitch);
    }

    /** Angle change achievable in one tick: quantized to whole pixels and converted back. */
    public float stepAngle(float angleDelta) {
        return mouseToAngle(angleToMouse(angleDelta));
    }

    /** Converts an angle delta to whole mouse pixels (rounded). */
    public double angleToMouse(float angleDelta) {
        float minAngleChange = mouseToAngle(1);
        return Math.round(angleDelta / minAngleChange);
    }

    /**
     * Converts pixels back to an angle. The mixed double/float precision is deliberate: one double
     * scale and one float scale, matching the rounding path of real mouse input.
     */
    public float mouseToAngle(double mouseDelta) {
        double f = sensitivity * (double) 0.6f + (double) 0.2f;
        return (float) (mouseDelta * f * f * f * 8.0d) * 0.15f;
    }

    /** With pitch unspecified, moves pitch 1° per tick toward the resting range. */
    public static float nudgeToLevel(float pitch) {
        if (pitch < PITCH_LEVEL_MIN) {
            return pitch + 1;
        } else if (pitch > PITCH_LEVEL_MAX) {
            return pitch - 1;
        }
        return pitch;
    }

    /** Normalizes an angle delta to (-180, 180] so turns take the short arc. */
    public static float normalizeDelta(float degrees) {
        float wrapped = degrees % 360.0f;
        if (wrapped <= -180.0f) {
            wrapped += 360.0f;
        }
        if (wrapped > 180.0f) {
            wrapped -= 360.0f;
        }
        return wrapped;
    }

    /** Clamps pitch to the physically reachable [-90, 90]. */
    public static float clampPitch(float pitch) {
        return Math.max(-90.0f, Math.min(90.0f, pitch));
    }

    /**
     * Input-vector frame transform. Movement direction is defined relative to the target yaw, but
     * entity physics interprets the input fields relative to the actual (stepped) yaw. This maps
     * input (xxa, zza) with the target yaw as forward onto the actual-yaw frame so both frames yield
     * the same world direction: while the view has not finished turning, movement still follows the
     * target heading.
     *
     * @param xxa strafe impulse in the target frame (left positive, right negative)
     * @param zza forward impulse in the target frame (forward positive, backward negative)
     * @param targetYawDeg target yaw that defines the movement direction (degrees)
     * @param actualYawDeg yaw currently applied to the entity (degrees)
     * @return {@code [xxa', zza']}, the values to write into the entity input fields
     */
    public static float[] remapInput(float xxa, float zza, float targetYawDeg, float actualYawDeg) {
        double d = Math.toRadians(targetYawDeg - actualYawDeg);
        float cos = (float) Math.cos(d);
        float sin = (float) Math.sin(d);
        return new float[]{xxa * cos - zza * sin, zza * cos + xxa * sin};
    }
}
