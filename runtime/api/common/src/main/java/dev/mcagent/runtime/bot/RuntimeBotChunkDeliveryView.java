package dev.mcagent.runtime.bot;

/** Read-only diagnostics implemented by vanilla's chunk sender for Runtime Bots. */
public interface RuntimeBotChunkDeliveryView {
    int pendingChunkCount();
    int unacknowledgedBatchCount();
}
