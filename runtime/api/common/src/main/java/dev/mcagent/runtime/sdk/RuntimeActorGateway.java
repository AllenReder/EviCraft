package dev.mcagent.runtime.sdk;

/** Explicit singleton Runtime Bot management exposed by the SDK dispatcher. */
public interface RuntimeActorGateway {

    /** Returns the current Runtime Bot projection, or {@code null} before creation. */
    RuntimeActorView get();

    /** Creates the Runtime Bot, or resolves the same case-insensitive username. */
    RuntimeActorView create(String username);
}
