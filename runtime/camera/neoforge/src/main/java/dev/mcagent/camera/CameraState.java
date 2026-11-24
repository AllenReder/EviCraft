package dev.mcagent.camera;

/** Client-thread facts the capture endpoint waits on. */
public final class CameraState {

    private static volatile int lastPing = Integer.MIN_VALUE;

    private CameraState() {}

    public static void pingHandled(int id) { lastPing = id; }

    public static int lastPing() { return lastPing; }

    static void reset() { lastPing = Integer.MIN_VALUE; }
}
