package dev.mcagent.runtime.core.pathing.settings;

import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import net.minecraft.world.item.Items;
import net.minecraft.server.level.ServerPlayer;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** World Run-scoped ordered Scaffold Material Glob policy. Requires the Minecraft Registry. */
@Tag("mc")
class ScaffoldMaterialsTest {

    private static boolean booted;

    @BeforeAll
    static void boot() {
        try {
            net.minecraft.SharedConstants.tryDetectVersion();
            net.minecraft.server.Bootstrap.bootStrap();
            booted = true;
        } catch (Throwable t) {
            booted = false;
        }
    }

    @Test
    void factoryDefaultsAreAtMostSixteenGlobsWithTheSameCuratedTwentyThreeBlockItems() {
        assumeTrue(booted);
        List<String> globs = ScaffoldMaterials.factoryDefaultGlobs();
        assertTrue(globs.size() <= 16);
        globs.forEach(CanonicalIdentifierGlob::compile);
        assertTrue(globs.stream().noneMatch(glob -> glob.startsWith("#")));
        assertEquals(Set.of(
                "minecraft:cobblestone", "minecraft:dirt", "minecraft:cobbled_deepslate",
                "minecraft:stone", "minecraft:netherrack", "minecraft:andesite",
                "minecraft:diorite", "minecraft:granite", "minecraft:tuff",
                "minecraft:deepslate", "minecraft:coarse_dirt", "minecraft:rooted_dirt",
                "minecraft:podzol", "minecraft:mud", "minecraft:mossy_cobblestone",
                "minecraft:grass_block", "minecraft:mycelium", "minecraft:calcite",
                "minecraft:blackstone", "minecraft:basalt", "minecraft:soul_soil",
                "minecraft:end_stone", "minecraft:snow_block"),
                Set.copyOf(ScaffoldMaterials.effectiveIds(null)));
    }

    @Test
    void writesValidateAndExpandAtomicallyThenReuseTheCachedEffectiveItemsUntilServerStop() throws Exception {
        assumeTrue(booted);
        ServerPlayer first = allocatePlayer(UUID.fromString("10000000-0000-4000-8000-000000000001"));
        ServerPlayer second = allocatePlayer(UUID.fromString("10000000-0000-4000-8000-000000000002"));
        try {
            ScaffoldMaterials.store(first, List.of(
                    "minecraft:*dirt", "minecraft:stone", "minecraft:*dirt"));
            assertEquals(List.of("minecraft:*dirt", "minecraft:stone"),
                    ScaffoldMaterials.storedGlobs(first));
            assertEquals(Set.of(Items.DIRT, Items.COARSE_DIRT, Items.ROOTED_DIRT, Items.STONE),
                    Set.copyOf(ScaffoldMaterials.of(first)));
            assertSame(ScaffoldMaterials.of(first), ScaffoldMaterials.of(first),
                    "pathing must reuse the expansion cached by the successful write");
            assertEquals(ScaffoldMaterials.factoryDefaultGlobs(),
                    ScaffoldMaterials.storedGlobs(second));

            assertWriteFailure(first, List.of("minecraft:[stone]"),
                    ScaffoldMaterials.FailureType.INVALID_ITEM_ID_GLOB);
            assertWriteFailure(first, List.of("minecraft:stick"),
                    ScaffoldMaterials.FailureType.NO_BLOCK_ITEM_MATCH);
            assertWriteFailure(first, List.of("minecraft:*"),
                    ScaffoldMaterials.FailureType.TOO_MANY_EFFECTIVE_ITEMS);
            assertWriteFailure(first, List.of(
                    "minecraft:stone", "minecraft:dirt", "minecraft:cobblestone",
                    "minecraft:netherrack", "minecraft:andesite", "minecraft:diorite",
                    "minecraft:granite", "minecraft:tuff", "minecraft:deepslate",
                    "minecraft:podzol", "minecraft:mud", "minecraft:grass_block",
                    "minecraft:mycelium", "minecraft:calcite", "minecraft:blackstone",
                    "minecraft:basalt", "minecraft:end_stone"),
                    ScaffoldMaterials.FailureType.TOO_MANY_ITEM_ID_GLOBS);
            assertEquals(List.of("minecraft:*dirt", "minecraft:stone"),
                    ScaffoldMaterials.storedGlobs(first), "every rejected write must roll back");

            dev.mcagent.runtime.platform.ServerLifecycle.fireStopped();
            assertEquals(ScaffoldMaterials.factoryDefaultGlobs(),
                    ScaffoldMaterials.storedGlobs(first));
        } finally {
            dev.mcagent.runtime.platform.ServerLifecycle.fireStopped();
        }
    }

    private static void assertWriteFailure(
            ServerPlayer player, List<String> globs, ScaffoldMaterials.FailureType expected) {
        ScaffoldMaterials.PolicyException failure = assertThrows(
                ScaffoldMaterials.PolicyException.class,
                () -> ScaffoldMaterials.store(player, globs));
        assertEquals(expected, failure.failureType());
    }

    private static ServerPlayer allocatePlayer(UUID uuid) throws Exception {
        Field theUnsafe = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
        theUnsafe.setAccessible(true);
        sun.misc.Unsafe unsafe = (sun.misc.Unsafe) theUnsafe.get(null);
        ServerPlayer player = (ServerPlayer) unsafe.allocateInstance(ServerPlayer.class);
        Field uuidField = net.minecraft.world.entity.Entity.class.getDeclaredField("uuid");
        uuidField.setAccessible(true);
        uuidField.set(player, uuid);
        return player;
    }
}
