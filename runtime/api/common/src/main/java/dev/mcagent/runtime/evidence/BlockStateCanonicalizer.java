package dev.mcagent.runtime.evidence;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.material.FluidState;

import java.util.Comparator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/** Stable canonical identifiers for evidence payloads. */
final class BlockStateCanonicalizer {

    // States are interned registry objects, so each one is canonicalized once.
    private static final Map<BlockState, String> BLOCKS = new ConcurrentHashMap<>();
    private static final Map<FluidState, String> FLUIDS = new ConcurrentHashMap<>();

    private BlockStateCanonicalizer() {}

    static String block(BlockState state) {
        return BLOCKS.computeIfAbsent(state, key -> withProperties(
                BuiltInRegistries.BLOCK.getKey(key.getBlock()).toString(), key.getValues()));
    }

    static String fluid(FluidState state) {
        return FLUIDS.computeIfAbsent(state, key -> withProperties(
                BuiltInRegistries.FLUID.getKey(key.getType()).toString(), key.getValues()));
    }

    private static String withProperties(String id, Map<Property<?>, Comparable<?>> values) {
        if (values.isEmpty()) return id;
        return id + values.entrySet().stream()
                .sorted(Comparator.comparing(entry -> entry.getKey().getName()))
                .map(entry -> entry.getKey().getName() + "=" + propertyValue(entry))
                .collect(Collectors.joining(",", "[", "]"));
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private static String propertyValue(Map.Entry<Property<?>, Comparable<?>> entry) {
        return ((Property) entry.getKey()).getName(entry.getValue());
    }
}
