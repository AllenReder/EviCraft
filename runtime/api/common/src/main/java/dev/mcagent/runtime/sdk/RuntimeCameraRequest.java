package dev.mcagent.runtime.sdk;

/**
 * One view request. Either an explicit direction ({@code yaw}/{@code pitch} in Minecraft degrees; a
 * {@code null} component keeps the current value) or a {@code targetBlock} whose center the Bot looks at.
 */
public record RuntimeCameraRequest(Float yaw, Float pitch, TargetBlock targetBlock) {

    public record TargetBlock(int x, int y, int z) {}

    public RuntimeCameraRequest {
        if (targetBlock != null && (yaw != null || pitch != null)) {
            throw new IllegalArgumentException("target_block excludes yaw and pitch");
        }
    }
}
