package dev.mcagent.runtime.sdk;

/** Receipt for one explicit, atomic selected-profile observation. */
public record RuntimeObservation(long observationRevision, long serverTick, long gameTime) {}
