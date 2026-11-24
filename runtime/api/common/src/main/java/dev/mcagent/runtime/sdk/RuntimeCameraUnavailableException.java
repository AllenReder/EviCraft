package dev.mcagent.runtime.sdk;

/** No view can be captured right now: no camera is configured or connected, or the Bot is absent. */
public final class RuntimeCameraUnavailableException extends IllegalStateException {
    public RuntimeCameraUnavailableException(String message) { super(message); }
}
