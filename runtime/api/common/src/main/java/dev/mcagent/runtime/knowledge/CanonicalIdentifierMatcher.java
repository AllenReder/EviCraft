package dev.mcagent.runtime.knowledge;

/** Full-match selector over one complete Canonical Registry ID. */
@FunctionalInterface
public interface CanonicalIdentifierMatcher {
    boolean matches(String canonicalId);
}
