package dev.mcagent.runtime.sdk;

import java.util.Objects;

/** Public version tuple reported by {@code runtime.info}. */
public record RuntimeBuildInfo(String buildVersion, String minecraftVersion, String neoForgeVersion) {
    public RuntimeBuildInfo {
        Objects.requireNonNull(buildVersion, "buildVersion");
        Objects.requireNonNull(minecraftVersion, "minecraftVersion");
        Objects.requireNonNull(neoForgeVersion, "neoForgeVersion");
    }
}
