package dev.mcagent.runtime.core.data;

import dev.mcagent.runtime.core.data.ModItemTagData.TagAppenderProvider;
import dev.mcagent.runtime.core.init.InitTag;
import net.minecraft.world.level.block.Block;

/**
 * Single source of truth for every block tag core module emits — mirrors
 * {@link ModItemTagData} but for the block registry. Both loaders' block-tag
 * providers forward here, so the content stays in {@code common/}.
 *
 * <h2>Adding a new tag</h2>
 * <ol>
 *   <li>Declare the {@code TagKey<Block>} in {@link InitTag}.</li>
 *   <li>Add a {@code tags.tag(InitTag.X).add(Blocks.Y)} block in {@link #addBlockTags}.</li>
 *   <li>Re-run {@code ./gradlew :fabric:runDatagen :neoforge:runData}.</li>
 * </ol>
 */
public final class ModBlockTagData {

    private ModBlockTagData() {}

    /**
     * do_not_break is the <b>single source of truth</b> for hard break protection; its default members are
     * facilities: beds, doors, trapdoors, fence gates. Criterion: breaking it must never be an autonomous
     * pathfinding decision. Closed wooden doors and fence gates still count as passable (the executor opens
     * them); an iron door is a deliberate setup by a player, so if it blocks the way, take another route or
     * report it; a bed is a spawn point, broken instantly and irreversibly. Vanilla tags are referenced
     * instead of listing members, so new wooden doors in later versions are included automatically.
     *
     * <p>Only autonomous breaking is blocked: the checks apply to pathfinding cost, build approach, and
     * blocker grinding; a task that names a specific cell to break does not go through them.
     * Functional blocks (crafting table, furnace, chest, trapped chest) are not in this tag; they get the
     * NavSettings.blocksToAvoidBreaking soft penalty (dig cost ×10, still broken when there is no other
     * path). Datapacks may freely add blocks to this tag for hard protection (never broken under any setting).
     */
    public static void addBlockTags(TagAppenderProvider<Block> tags) {
        tags.tag(InitTag.DO_NOT_BREAK)
                .addTag(net.minecraft.tags.BlockTags.BEDS)
                .addTag(net.minecraft.tags.BlockTags.DOORS)
                .addTag(net.minecraft.tags.BlockTags.TRAPDOORS)
                .addTag(net.minecraft.tags.BlockTags.FENCE_GATES);

        // Blocks whose block entity data a blueprint may bring into the world. By default only signs and
        // banners: sign text is plain text (a player writing it gets nothing either), and a banner's pattern
        // is part of the design, with the material charged as the patterned banner. Neither creates anything
        // from nothing.
        //
        // Vanilla tags are referenced instead of listing members: members change across versions (1.20 added
        // hanging signs), while "all signs" keeps its meaning.
        //
        // Adding a container to this tag lets blueprints print its contents. That is the datapack author's
        // decision, but it must be an informed one.
        tags.tag(InitTag.SAFE_BLOCK_ENTITY_DATA)
                .addTag(net.minecraft.tags.BlockTags.ALL_SIGNS)
                .addTag(net.minecraft.tags.BlockTags.BANNERS);
    }
}
