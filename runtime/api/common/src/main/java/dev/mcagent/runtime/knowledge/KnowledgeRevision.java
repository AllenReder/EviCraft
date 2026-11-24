package dev.mcagent.runtime.knowledge;

/** World Run-local identity of one ordered World Knowledge publication. */
public record KnowledgeRevision(long value) {
    public KnowledgeRevision {
        if (value < 0L) throw new IllegalArgumentException("revision must not be negative");
    }
}
