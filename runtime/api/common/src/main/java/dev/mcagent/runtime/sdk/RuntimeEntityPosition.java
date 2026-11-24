package dev.mcagent.runtime.sdk;

/** Exact remembered entity position without a live-world lookup. */
public record RuntimeEntityPosition(double x, double y, double z) {
    public RuntimeEntityPosition {
        if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)) {
            throw new IllegalArgumentException("entity position must be finite");
        }
    }
}
