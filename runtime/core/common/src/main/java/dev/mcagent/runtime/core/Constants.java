package dev.mcagent.runtime.core;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Identity constants for the core module. The engine
 * (the api module) has its own {@code dev.mcagent.runtime.Constants}; this is
 * deliberately a separate type in a separate package so the two mods never put
 * the same fully-qualified class on the runtime classpath.
 */
public final class Constants {

    public static final String MOD_ID = "mc_agent";
    public static final String MOD_NAME = "EviCraft Runtime";
    public static final Logger LOG = LoggerFactory.getLogger(MOD_NAME);

    private Constants() {}
}
