package dev.mcagent.runtime.sdk;

import java.util.List;
import java.util.Objects;

/** Palette-compressed inclusive block region with x-fastest flattened indices. */
public record RuntimeBlockRegionResult(
        String dimension,
        RuntimeBlockPosition min,
        RuntimeBlockPosition size,
        List<RuntimeBlockPaletteEntry> palette,
        List<Integer> indices,
        boolean complete
) {
    public RuntimeBlockRegionResult {
        Objects.requireNonNull(dimension, "dimension");
        Objects.requireNonNull(min, "min");
        Objects.requireNonNull(size, "size");
        palette = List.copyOf(Objects.requireNonNull(palette, "palette"));
        indices = List.copyOf(Objects.requireNonNull(indices, "indices"));
        long volume = Math.multiplyExact(Math.multiplyExact((long) size.x(), size.y()), size.z());
        if (size.x() < 1 || size.y() < 1 || size.z() < 1
                || volume != indices.size() || palette.isEmpty()) {
            throw new IllegalArgumentException("invalid bounded block region");
        }
        for (int index : indices) {
            if (index < 0 || index >= palette.size()) {
                throw new IllegalArgumentException("region index is outside its palette");
            }
        }
    }
}
