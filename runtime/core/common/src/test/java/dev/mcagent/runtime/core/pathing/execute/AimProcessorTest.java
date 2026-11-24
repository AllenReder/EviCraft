package dev.mcagent.runtime.core.pathing.execute;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Pins down the math of quantized view stepping: pixel round trips, convergence to within half a pixel
 * in one tick, stopping at the residual, pitch leveling and clamping, unnormalized yaw accumulation,
 * and the input-frame transform.
 */
class AimProcessorTest {

    private static final float EPS = 1e-4f;

    /** At the default sensitivity 0.5, one pixel is exactly 0.15°. */
    @Test
    void onePixelIsPointFifteenDegrees() {
        AimProcessor aim = new AimProcessor();
        assertEquals(0.15f, aim.mouseToAngle(1), EPS);
    }

    /** Angle → pixels → angle round trip: lossless for whole-pixel angles. */
    @Test
    void roundTripOnPixelGrid() {
        AimProcessor aim = new AimProcessor();
        for (int px = -300; px <= 300; px += 7) {
            float angle = aim.mouseToAngle(px);
            assertEquals(px, aim.angleToMouse(angle), 0.0);
            assertEquals(angle, aim.stepAngle(angle), EPS);
        }
    }

    /** After one tick of stepping a large delta, the residual is within half a pixel. */
    @Test
    void largeDeltaConvergesWithinHalfPixelInOneTick() {
        AimProcessor aim = new AimProcessor();
        float halfPixel = aim.mouseToAngle(1) / 2;
        for (float delta : new float[]{179.9f, 90.0f, 37.37f, -0.5f, -123.456f}) {
            float stepped = aim.stepAngle(delta);
            assertTrue(Math.abs(delta - stepped) <= halfPixel + EPS,
                    "delta=" + delta + " stepped=" + stepped);
        }
    }

    /** A residual under half a pixel rounds to 0 pixels, so the view stays put (no jitter). */
    @Test
    void subHalfPixelResidualStops() {
        AimProcessor aim = new AimProcessor();
        float halfPixel = aim.mouseToAngle(1) / 2;
        assertEquals(0.0f, aim.stepAngle(halfPixel * 0.9f), 0.0f);
        assertEquals(0.0f, aim.stepAngle(-halfPixel * 0.9f), 0.0f);
    }

    /**
     * Multi-tick iteration: repeated stepping from any angle converges monotonically and settles within
     * half a pixel.
     */
    @Test
    void iterativeSteppingConverges() {
        AimProcessor aim = new AimProcessor();
        float halfPixel = aim.mouseToAngle(1) / 2;
        float current = -170.0f;
        float target = 155.0f;
        for (int tick = 0; tick < 5; tick++) {
            AimProcessor.Rotation r = aim.step(current, 0, target, 30.0f);
            current = r.yaw();
        }
        assertTrue(Math.abs(AimProcessor.normalizeDelta(target - current)) <= halfPixel + EPS);
    }

    /**
     * The yaw delta is not normalized: the raw delta accumulates and the view field may go out of range.
     * From -170° to 170° the raw delta is +340°, so the step moves in the positive direction (long arc)
     * rather than the normalized -20° short arc. Angle comparisons still use the short arc
     * ({@link AimProcessor#normalizeDelta}).
     */
    @Test
    void yawDeltaNotNormalized() {
        assertEquals(-20.0f, AimProcessor.normalizeDelta(170.0f - (-170.0f)), EPS);
        AimProcessor aim = new AimProcessor();
        AimProcessor.Rotation r = aim.step(-170.0f, 0, 170.0f, 30.0f);
        // Raw delta +340° → step moves positive (long arc), not the short arc
        assertTrue(r.yaw() > -170.0f);
    }

    /** With pitch unspecified (equal to current), pitch moves 1° per tick toward [-20, 10]. */
    @Test
    void pitchNudgesToLevelWhenUnspecified() {
        assertEquals(-39.0f, AimProcessor.nudgeToLevel(-40.0f), EPS);
        assertEquals(89.0f, AimProcessor.nudgeToLevel(90.0f), EPS);
        assertEquals(-20.0f, AimProcessor.nudgeToLevel(-20.0f), EPS);
        assertEquals(10.0f, AimProcessor.nudgeToLevel(10.0f), EPS);
        assertEquals(0.0f, AimProcessor.nudgeToLevel(0.0f), EPS);

        AimProcessor aim = new AimProcessor();
        // Target pitch == current pitch (90°, left over from looking straight up) → one leveling step
        AimProcessor.Rotation r = aim.step(0, 90.0f, 45.0f, 90.0f);
        assertTrue(r.pitch() < 90.0f);
    }

    /** With pitch specified, no leveling; step straight to the target. */
    @Test
    void pitchStepsWhenSpecified() {
        AimProcessor aim = new AimProcessor();
        AimProcessor.Rotation r = aim.step(0, 0, 0, 90.0f);
        assertEquals(90.0f, r.pitch(), aim.mouseToAngle(1));
    }

    /** Pitch is clamped to [-90, 90]. */
    @Test
    void pitchClamped() {
        assertEquals(90.0f, AimProcessor.clampPitch(120.0f), EPS);
        assertEquals(-90.0f, AimProcessor.clampPitch(-95.0f), EPS);
    }

    /** Input-frame transform: identity when the frames agree. */
    @Test
    void remapIdentityWhenFramesAgree() {
        float[] v = AimProcessor.remapInput(0.0f, 1.0f, 45.0f, 45.0f);
        assertEquals(0.0f, v[0], EPS);
        assertEquals(1.0f, v[1], EPS);
    }

    /**
     * Input-frame transform: when the target yaw leads the actual yaw by 90°, forward in the target frame
     * must become right strafe in the actual frame to produce the same world direction.
     */
    @Test
    void remapForwardBecomesStrafeAtNinetyDegrees() {
        float[] v = AimProcessor.remapInput(0.0f, 1.0f, 90.0f, 0.0f);
        assertEquals(-1.0f, v[0], EPS); // negative xxa = strafe right
        assertEquals(0.0f, v[1], EPS);
    }

    /** The input-frame transform preserves magnitude (impulse is neither amplified nor reduced). */
    @Test
    void remapPreservesMagnitude() {
        float[] v = AimProcessor.remapInput(0.3f, 0.7f, 123.0f, -37.0f);
        double before = Math.sqrt(0.3 * 0.3 + 0.7 * 0.7);
        double after = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
        assertEquals(before, after, 1e-4);
    }
}
