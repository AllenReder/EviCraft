package dev.mcagent.runtime.core.data;

import dev.mcagent.runtime.core.init.InitTag;

import net.minecraft.tags.BlockTags;
import net.minecraft.tags.TagKey;
import net.minecraft.world.level.block.Block;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Pins the default members of do_not_break at their single source of truth ({@link ModBlockTagData}).
 * The membership criteria are documented there; this only ensures that "facility blocks are hard-protected
 * by default" is not changed silently. The tag-to-INF mechanism is pinned separately by ProtectionPinsTest.
 *
 * <p>Pure JVM: records through a fake Appender and handles only TagKeys; no registry access, no bootstrap.
 */
class ModBlockTagDataTest {

    @Test
    void doNotBreakDefaultsToFacilityTags() {
        Map<TagKey<Block>, List<TagKey<Block>>> tagRefs = new HashMap<>();
        Map<TagKey<Block>, List<Block>> directAdds = new HashMap<>();
        ModBlockTagData.addBlockTags(key -> ModItemTagData.appender(
                b -> directAdds.computeIfAbsent(key, k -> new ArrayList<>()).add(b),
                t -> tagRefs.computeIfAbsent(key, k -> new ArrayList<>()).add(t)));

        assertEquals(
                List.of(BlockTags.BEDS, BlockTags.DOORS, BlockTags.TRAPDOORS, BlockTags.FENCE_GATES),
                tagRefs.get(InitTag.DO_NOT_BREAK));
        // Vanilla tag references only: members follow the game version without listing each block
        assertNull(directAdds.get(InitTag.DO_NOT_BREAK));
    }
}
