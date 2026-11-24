package dev.mcagent.runtime.sdk;

/** One rendered first-person frame and the Bot pose it was rendered from. */
public record RuntimeCameraCapture(byte[] png, int width, int height, String dimension,
                                   double eyeX, double eyeY, double eyeZ, float yaw, float pitch,
                                   long serverTick, RuntimeCameraRequest.TargetBlock targetBlock) {}
