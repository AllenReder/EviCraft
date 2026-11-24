package dev.mcagent.runtime.api.gametest;

import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.sdk.DefaultRuntimeToolGateway;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CakeBlock;
import net.minecraft.world.level.block.LeverBlock;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.phys.Vec3;

import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiConsumer;

public final class VerifiedBlockInteractionGameTests {
    private VerifiedBlockInteractionGameTests() {}

    public static void activate_block_opens_storage_crafting_and_furnace_menus_with_body_restoration(
            GameTestHelper helper) {
        activate_block_opens_storage_crafting_and_furnace_menus_with_body_restoration(
                helper, null);
    }

    public static void activate_block_opens_storage_crafting_and_furnace_menus_with_body_restoration(
            GameTestHelper helper, BiConsumer<BotPlayer, BlockPos> faceAssertion) {
        Fixture fixture = fixture(helper, Blocks.CHEST.defaultBlockState(), 41L);
        if (faceAssertion != null) faceAssertion.accept(fixture.bot(), fixture.target());
        fixture.bot().getInventory().setItem(0, new ItemStack(Items.DIAMOND_AXE));
        fixture.bot().getInventory().selected = 0;
        fixture.bot().setItemInHand(net.minecraft.world.InteractionHand.OFF_HAND,
                new ItemStack(Items.COBBLESTONE));
        fixture.bot().setShiftKeyDown(true);
        Fixture crafting = fixture.withTarget(fixture.target().north(2));
        Fixture furnace = fixture.withTarget(fixture.target().south(2));
        setTarget(crafting, Blocks.CRAFTING_TABLE.defaultBlockState());
        setTarget(furnace, Blocks.FURNACE.defaultBlockState());
        bind(fixture, crafting, furnace);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "activate-menu", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block menu call did not terminate"))
                .thenExecute(() -> {
                    assertMenuSuccess(helper, fixture, terminal.get(), "chest");
                    fixture.bot().closeContainer();
                    terminal.set(null);
                    call(crafting, "activate-crafting", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block crafting-table call did not terminate"))
                .thenExecute(() -> {
                    assertMenuSuccess(helper, crafting, terminal.get(), "crafting table");
                    fixture.bot().closeContainer();
                    terminal.set(null);
                    call(furnace, "activate-furnace", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block furnace call did not terminate"))
                .thenExecute(() -> {
                    assertMenuSuccess(helper, furnace, terminal.get(), "furnace");
                    fixture.bot().closeContainer();
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void activate_block_requires_state_change_and_rejects_changed_evidence(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, Blocks.LEVER.defaultBlockState()
                .setValue(LeverBlock.FACE,
                        net.minecraft.world.level.block.state.properties.AttachFace.FLOOR)
                .setValue(BlockStateProperties.HORIZONTAL_FACING, net.minecraft.core.Direction.NORTH), 42L);
        Fixture stone = fixture.withTarget(fixture.target().north(2));
        Fixture changed = fixture.withTarget(fixture.target().south(2));
        Fixture cake = fixture.withTarget(fixture.target().south(4));
        setTarget(stone, Blocks.STONE.defaultBlockState());
        setTarget(changed, Blocks.CRAFTING_TABLE.defaultBlockState());
        cake.level().setBlockAndUpdate(cake.target().below(), Blocks.STONE.defaultBlockState());
        setTarget(cake, Blocks.CAKE.defaultBlockState());
        fixture.bot().getInventory().setItem(2, new ItemStack(Items.DIAMOND_AXE));
        fixture.bot().getInventory().selected = 2;
        fixture.bot().setItemInHand(net.minecraft.world.InteractionHand.OFF_HAND,
                new ItemStack(Items.COBBLESTONE));
        fixture.bot().setShiftKeyDown(true);
        fixture.bot().getFoodData().setFoodLevel(10);
        bind(fixture, stone, changed, cake);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "activate-lever", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block lever call did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && "block_state_changed".equals(result.getAsJsonObject("data")
                                    .get("outcome").getAsString())
                                    && fixture.level().getBlockState(fixture.target())
                                    .getValue(BlockStateProperties.POWERED),
                            "activate_block did not verify the lever state change: " + terminal.get());
                    assertBodyRestored(helper, fixture, Items.DIAMOND_AXE, Items.COBBLESTONE, 2);
                    terminal.set(null);
                    call(stone, "activate-stone", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block stone call did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && "no_effect".equals(result.getAsJsonObject("data")
                                    .get("failure_type").getAsString()),
                            "non-interactive stone was not a typed no_effect: " + terminal.get());
                    assertBodyRestored(helper, fixture, Items.DIAMOND_AXE, Items.COBBLESTONE, 2);
                    for (net.minecraft.core.Direction direction : net.minecraft.core.Direction.values()) {
                        helper.assertTrue(!stone.level().getBlockState(stone.target().relative(direction))
                                        .is(Blocks.COBBLESTONE),
                                "activate_block fell back to the occupied offhand");
                    }
                    terminal.set(null);
                    call(cake, "activate-cake", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block cake call did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && "block_state_changed".equals(result.getAsJsonObject("data")
                                    .get("outcome").getAsString())
                                    && cake.level().getBlockState(cake.target()).getValue(CakeBlock.BITES) == 1,
                            "activate_block did not perform exactly one cake dispatch: " + terminal.get());
                    assertBodyRestored(helper, fixture, Items.DIAMOND_AXE, Items.COBBLESTONE, 2);
                    setTarget(changed, Blocks.FURNACE.defaultBlockState());
                    terminal.set(null);
                    call(changed, "activate-changed", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block changed-target call did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && "target_changed".equals(result.getAsJsonObject("data")
                                    .get("failure_type").getAsString()),
                            "changed evidence was not rejected structurally: " + terminal.get());
                    assertBodyRestored(helper, fixture, Items.DIAMOND_AXE, Items.COBBLESTONE, 2);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void activate_block_rejects_open_menu_unknown_reach_and_occlusion(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, Blocks.CHEST.defaultBlockState(), 43L);
        fixture.bot().getInventory().setItem(0, new ItemStack(Items.DIAMOND_AXE));
        fixture.bot().getInventory().selected = 0;
        fixture.bot().setItemInHand(net.minecraft.world.InteractionHand.OFF_HAND,
                new ItemStack(Items.COBBLESTONE));
        fixture.bot().setShiftKeyDown(true);
        Fixture reach = fixture.withTarget(fixture.target().north(2));
        Fixture occluded = fixture.withTarget(fixture.target().south(2));
        setTarget(reach, Blocks.STONE.defaultBlockState());
        setTarget(occluded, Blocks.STONE.defaultBlockState());
        bind(fixture, reach, occluded);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "open-menu", terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block setup Menu call did not terminate"))
                .thenExecute(() -> {
                    assertMenuSuccess(helper, fixture, terminal.get(), "setup chest");
                    terminal.set(null);
                    call(fixture, "reject-open-menu", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block open-Menu rejection did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "menu_open");
                    assertBodyRestored(helper, fixture, Items.DIAMOND_AXE, Items.COBBLESTONE, 0);
                    fixture.bot().closeContainer();
                    BlockPos unknown = fixture.target().north(20);
                    fixture.level().setBlockAndUpdate(unknown, Blocks.STONE.defaultBlockState());
                    terminal.set(null);
                    call(fixture.withTarget(unknown), "reject-unknown", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block unknown-target rejection did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "target_not_known_block");
                    assertBodyRestored(helper, fixture, Items.DIAMOND_AXE, Items.COBBLESTONE, 0);
                    fixture.bot().moveTo(reach.target().getX() - 9.5,
                            reach.target().getY() - 1, reach.target().getZ() + 0.5,
                            -90.0F, 0.0F);
                    terminal.set(null);
                    call(reach, "reject-reach", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block out-of-reach rejection did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "out_of_reach");
                    assertBodyRestored(helper, fixture, Items.DIAMOND_AXE, Items.COBBLESTONE, 0);
                    BlockPos feet = fixture.target().west(2).below();
                    fixture.bot().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    for (net.minecraft.core.Direction direction : net.minecraft.core.Direction.values()) {
                        fixture.level().setBlockAndUpdate(occluded.target().relative(direction),
                                Blocks.OBSIDIAN.defaultBlockState());
                    }
                    setTarget(occluded, Blocks.STONE.defaultBlockState());
                    terminal.set(null);
                    call(occluded, "reject-occluded", terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block occlusion rejection did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), "occluded");
                    assertBodyRestored(helper, fixture, Items.DIAMOND_AXE, Items.COBBLESTONE, 0);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void activate_block_restores_body_on_interruption_and_timeout(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, Blocks.STONE.defaultBlockState(), 44L);
        fixture.bot().getInventory().setItem(3, new ItemStack(Items.DIAMOND_PICKAXE));
        fixture.bot().getInventory().selected = 3;
        fixture.bot().setItemInHand(net.minecraft.world.InteractionHand.OFF_HAND,
                new ItemStack(Items.TORCH));
        fixture.bot().setShiftKeyDown(true);
        bind(fixture);
        AtomicReference<String> terminal = new AtomicReference<>();
        boolean[] cancelled = new boolean[1];

        helper.startSequence()
                .thenExecute(() -> {
                    JsonObject args = args(fixture.target());
                    var id = JsonParser.parseString("\"activate-cancel\"");
                    fixture.tools().call(id, "activate_block", args, terminal::set);
                    cancelled[0] = fixture.tools().cancel(id);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block cancellation did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(cancelled[0] && !result.get("success").getAsBoolean()
                                    && result.get("interrupted").getAsBoolean(),
                            "activate_block did not return interrupted cancellation: " + terminal.get());
                    assertBodyRestored(helper, fixture, Items.DIAMOND_PICKAXE, Items.TORCH, 3);
                    helper.assertTrue(result.getAsJsonObject("data").size() == 1
                                    && result.getAsJsonObject("data").has("position"),
                            "interrupted activate_block leaked non-contract result data: " + terminal.get());
                    terminal.set(null);
                    fixture.tools().call(JsonParser.parseString("\"activate-timeout\""),
                            "activate_block", args(fixture.target()), terminal::set);
                    ((net.minecraft.world.level.storage.ServerLevelData)
                            fixture.level().getLevelData())
                            .setGameTime(fixture.level().getGameTime() + 601L);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "activate_block timeout did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && result.get("timed_out").getAsBoolean(),
                            "activate_block did not return timeout: " + terminal.get());
                    assertBodyRestored(helper, fixture, Items.DIAMOND_PICKAXE, Items.TORCH, 3);
                    helper.assertTrue(result.getAsJsonObject("data").size() == 1
                                    && result.getAsJsonObject("data").has("position"),
                            "timed-out activate_block leaked non-contract result data: " + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    private static Fixture fixture(GameTestHelper helper,
                                   net.minecraft.world.level.block.state.BlockState targetState,
                                   long session) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.stop(level.getServer());
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        BlockPos feet = helper.absolutePos(new BlockPos(4, 4, 4));
        BlockPos target = feet.east(2).above();
        for (BlockPos position : BlockPos.betweenClosed(
                feet.offset(-2, -2, -3), feet.offset(5, 4, 3))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
        level.setBlockAndUpdate(target.below(), Blocks.STONE.defaultBlockState());
        level.setBlockAndUpdate(target, targetState);
        bot.getInventory().clearContent();
        bot.setItemInHand(net.minecraft.world.InteractionHand.OFF_HAND, ItemStack.EMPTY);
        bot.setHealth(bot.getMaxHealth());
        bot.fallDistance = 0.0F;
        bot.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, -90.0F, 0.0F);
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(session);
        return new Fixture(level, bot, target, tools);
    }

    private static void bind(Fixture... fixtures) {
        RuntimeBotManager.tick(fixtures[0].level().getServer());
        for (Fixture fixture : fixtures) {
            RuntimeKnowledgeFixtures.publishBlock(
                    fixture.level().getServer(),
                    fixture.level().dimension().location().toString(),
                    fixture.level().getGameTime(), fixture.target(),
                    fixture.level().getBlockState(fixture.target()), BlockEvidenceSource.MISMATCH);
        }
    }

    private static void call(Fixture fixture, String id, AtomicReference<String> terminal) {
        fixture.tools().call(JsonParser.parseString('"' + id + '"'),
                "activate_block", args(fixture.target()), terminal::set);
    }

    private static JsonObject args(BlockPos target) {
        JsonObject args = new JsonObject();
        JsonObject position = new JsonObject();
        position.addProperty("x", target.getX());
        position.addProperty("y", target.getY());
        position.addProperty("z", target.getZ());
        args.add("position", position);
        return args;
    }

    private static void setTarget(Fixture fixture,
                                  net.minecraft.world.level.block.state.BlockState state) {
        fixture.level().setBlockAndUpdate(fixture.target(), state);
    }

    private static void assertMenuSuccess(GameTestHelper helper, Fixture fixture,
                                          String terminal, String kind) {
        JsonObject result = JsonParser.parseString(terminal).getAsJsonObject();
        helper.assertTrue(result.get("success").getAsBoolean()
                        && "menu_opened".equals(result.getAsJsonObject("data")
                        .get("outcome").getAsString()),
                "activate_block did not verify the " + kind + " Menu: " + terminal);
        assertBodyRestored(helper, fixture, Items.DIAMOND_AXE, Items.COBBLESTONE, 0);
    }

    private static void assertFailure(GameTestHelper helper, String terminal, String expected) {
        JsonObject result = JsonParser.parseString(terminal).getAsJsonObject();
        helper.assertTrue(!result.get("success").getAsBoolean()
                        && expected.equals(result.getAsJsonObject("data")
                        .get("failure_type").getAsString()),
                "activate_block did not return " + expected + ": " + terminal);
    }

    private static void assertBodyRestored(GameTestHelper helper, Fixture fixture,
                                           net.minecraft.world.item.Item main,
                                           net.minecraft.world.item.Item offhand,
                                           int selected) {
        helper.assertTrue(fixture.bot().getMainHandItem().is(main)
                        && fixture.bot().getOffhandItem().is(offhand)
                        && fixture.bot().getInventory().selected == selected
                        && fixture.bot().isShiftKeyDown(),
                "activate_block leaked temporary hand, slot, offhand, or sneak state");
    }

    private static void cleanup(Fixture fixture) {
        fixture.bot().closeContainer();
        fixture.bot().getInventory().clearContent();
        fixture.bot().setItemInHand(net.minecraft.world.InteractionHand.OFF_HAND, ItemStack.EMPTY);
        fixture.bot().setShiftKeyDown(false);
        fixture.bot().setDeltaMovement(Vec3.ZERO);
        fixture.bot().fallDistance = 0.0F;
        Vec3 spawn = Vec3.atBottomCenterOf(fixture.level().getSharedSpawnPos());
        fixture.bot().moveTo(spawn.x, spawn.y, spawn.z,
                fixture.bot().getYRot(), fixture.bot().getXRot());
    }

    private record Fixture(ServerLevel level, BotPlayer bot, BlockPos target,
                           DefaultRuntimeToolGateway tools) {
        private Fixture withTarget(BlockPos replacement) {
            return new Fixture(level, bot, replacement, tools);
        }
    }
}
