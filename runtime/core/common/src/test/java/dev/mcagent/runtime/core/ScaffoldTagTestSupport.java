package dev.mcagent.runtime.core;

import dev.mcagent.runtime.core.init.InitTag;

import net.minecraft.core.MappedRegistry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;

import java.util.List;

/**
 * Binds the scaffold-material tag for headless tests.
 *
 * <p>{@code mc_agent:scaffolds} is populated from a datapack, but {@code Bootstrap.bootStrap()} only builds
 * the registries and loads no datapacks. Unbound, the tag is empty, so the Bot owns no scaffold material:
 * every pillar/bridge move in pathfinding prices as {@code COST_INF}, and the cost and material-selection
 * tests all fail with no visible cause.
 *
 * <p>This uses vanilla's own {@link MappedRegistry#bindTag} (the same path datapack loading takes), so
 * production code needs no test hooks. The bound members are a small set <b>declared by the test</b>, not
 * read from datagen output: those files are not checked in, and tests must not depend on datagen having run.
 */
public final class ScaffoldTagTestSupport {

    /** Minimal set: cost and priority tests only need "some material" and "dirt ranks before cobblestone". */
    private static final List<Item> MATERIALS = List.of(
            Items.DIRT, Items.COBBLESTONE, Items.STONE, Items.NETHERRACK,
            Items.COBBLED_DEEPSLATE, Items.COARSE_DIRT);

    private ScaffoldTagTestSupport() {}

    /** Idempotent: safe to call from every test class's {@code @BeforeAll}. */
    @SuppressWarnings("unchecked")
    public static void bind() {
        ((MappedRegistry<Item>) BuiltInRegistries.ITEM).bindTags(java.util.Map.of(
                InitTag.SCAFFOLDS,
                MATERIALS.stream().map(BuiltInRegistries.ITEM::wrapAsHolder).toList()));
    }
}
