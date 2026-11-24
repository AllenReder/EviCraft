package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

@Tag("mc")
class ScaffoldOpsTest {

    private static boolean booted;

    @BeforeAll
    static void boot() {
        try {
            net.minecraft.SharedConstants.tryDetectVersion();
            net.minecraft.server.Bootstrap.bootStrap();
            booted = true;
        } catch (Throwable failure) {
            booted = false;
        }
    }

    @AfterEach
    void resetWorldRun() {
        dev.mcagent.runtime.platform.ServerLifecycle.fireStopped();
    }

    @Test
    void readAddDeleteSetAndClearReturnCanonicalPolicyProjectionsAndMutateAtomically() throws Exception {
        assumeTrue(booted);
        BotPlayer player = allocatePlayer();
        player.getInventory().items.set(0, new ItemStack(Items.DIRT, 2));
        player.getInventory().items.set(1, new ItemStack(Items.COARSE_DIRT, 3));
        player.getInventory().items.set(2, new ItemStack(Items.STONE, 4));
        player.getInventory().items.set(3, new ItemStack(Items.STICK, 5));
        ScaffoldOps operations = new ScaffoldOps();

        JsonObject set = result(operations.apply("set", List.of(
                "minecraft:*dirt", "minecraft:stone", "minecraft:*dirt"), player));
        assertTrue(set.get("success").getAsBoolean());
        assertEquals("set", set.getAsJsonObject("data").get("action").getAsString());
        assertEquals(List.of("minecraft:*dirt", "minecraft:stone"), strings(set, "item_id_globs"));
        assertEquals(4, set.getAsJsonObject("data").get("effective_item_count").getAsInt());
        assertEquals(List.of(
                "minecraft:dirt:2", "minecraft:coarse_dirt:3", "minecraft:stone:4"),
                carried(set));

        JsonObject exactNoOp = result(operations.apply(
                "delete", List.of("minecraft:coarse_dirt"), player));
        assertTrue(exactNoOp.get("success").getAsBoolean());
        assertEquals(List.of("minecraft:*dirt", "minecraft:stone"), strings(exactNoOp, "item_id_globs"));

        JsonObject deleted = result(operations.apply("delete", List.of("minecraft:stone"), player));
        assertTrue(deleted.get("success").getAsBoolean());
        assertEquals(List.of("minecraft:*dirt"), strings(deleted, "item_id_globs"));

        JsonObject added = result(operations.apply("add", List.of(
                "minecraft:mud", "minecraft:*dirt"), player));
        assertTrue(added.get("success").getAsBoolean());
        assertEquals(List.of("minecraft:*dirt", "minecraft:mud"), strings(added, "item_id_globs"));

        JsonObject rejected = result(operations.apply("set", List.of("minecraft:stick"), player));
        assertFalse(rejected.get("success").getAsBoolean());
        assertEquals("no_block_item_match",
                rejected.getAsJsonObject("data").get("failure_type").getAsString());
        assertEquals(List.of("minecraft:*dirt", "minecraft:mud"), strings(rejected, "item_id_globs"));

        JsonObject cleared = result(operations.apply("clear", null, player));
        assertTrue(cleared.get("success").getAsBoolean());
        assertEquals(List.of(), strings(cleared, "item_id_globs"));
        assertEquals(0, cleared.getAsJsonObject("data").get("effective_item_count").getAsInt());

        JsonObject missingSet = result(operations.apply("set", null, player));
        assertFalse(missingSet.get("success").getAsBoolean());
        assertEquals("missing_item_id_globs",
                missingSet.getAsJsonObject("data").get("failure_type").getAsString());
        assertEquals(List.of(), strings(missingSet, "item_id_globs"));
    }

    private static JsonObject result(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    private static List<String> strings(JsonObject result, String field) {
        return result.getAsJsonObject("data").getAsJsonArray(field).asList().stream()
                .map(value -> value.getAsString()).toList();
    }

    private static List<String> carried(JsonObject result) {
        return result.getAsJsonObject("data").getAsJsonArray("carried_matching_items").asList().stream()
                .map(value -> value.getAsJsonObject())
                .map(value -> value.get("item_id").getAsString() + ":" + value.get("count").getAsInt())
                .toList();
    }

    private static BotPlayer allocatePlayer() throws Exception {
        Field theUnsafe = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
        theUnsafe.setAccessible(true);
        sun.misc.Unsafe unsafe = (sun.misc.Unsafe) theUnsafe.get(null);
        BotPlayer player = (BotPlayer) unsafe.allocateInstance(BotPlayer.class);
        Field uuidField = net.minecraft.world.entity.Entity.class.getDeclaredField("uuid");
        uuidField.setAccessible(true);
        uuidField.set(player, UUID.fromString("20000000-0000-4000-8000-000000000001"));
        Field inventory = Player.class.getDeclaredField("inventory");
        inventory.setAccessible(true);
        inventory.set(player, new Inventory(player));
        return player;
    }
}
