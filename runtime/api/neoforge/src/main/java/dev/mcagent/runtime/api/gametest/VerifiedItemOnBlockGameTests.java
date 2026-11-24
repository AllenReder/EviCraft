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
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.EndPortalFrameBlock;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.phys.Vec3;

import java.util.concurrent.atomic.AtomicReference;

public final class VerifiedItemOnBlockGameTests {
    private VerifiedItemOnBlockGameTests() {}

    public static void flint_and_eye_report_exact_effects_and_restore_inventory(GameTestHelper helper) {
        Fixture flint = fixture(helper, Blocks.OBSIDIAN.defaultBlockState(), 51L);
        Fixture frame = flint.withTarget(flint.target().north(2));
        setTarget(frame, Blocks.END_PORTAL_FRAME.defaultBlockState()
                .setValue(EndPortalFrameBlock.HAS_EYE, false)
                .setValue(BlockStateProperties.HORIZONTAL_FACING, net.minecraft.core.Direction.NORTH));
        BlockPos portalInteriorCandidate = flint.target().west();
        flint.level().setBlockAndUpdate(portalInteriorCandidate.below(),
                Blocks.OBSIDIAN.defaultBlockState());
        prepareInventory(flint, Items.FLINT_AND_STEEL, 5, Items.TORCH, false);
        flint.bot().getInventory().setItem(6, new ItemStack(Items.ENDER_EYE, 2));
        bind(flint, frame);
        AtomicReference<String> flintTerminal = new AtomicReference<>();
        AtomicReference<String> eyeTerminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(flint, "item-flint", "minecraft:flint_and_steel", flintTerminal))
                .thenWaitUntil(() -> helper.assertTrue(
                        flint.bot().getMainHandItem().is(Items.FLINT_AND_STEEL)
                                && flint.bot().getMainHandItem().getDamageValue() == 1,
                        "flint dispatch did not complete before terminal publication"))
                .thenExecute(() -> setTarget(flint, Blocks.DIRT.defaultBlockState()))
                .thenWaitUntil(() -> helper.assertTrue(flintTerminal.get() != null,
                        "use_item_on_block flint call did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(flintTerminal.get());
                    net.minecraft.core.Direction face = net.minecraft.core.Direction.byName(
                            data(result).get("face").getAsString());
                    BlockPos fire = flint.target().relative(face);
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && "adjacent_block_changed".equals(data(result).get("outcome").getAsString())
                                    && face != null
                                    && positionEquals(data(result).getAsJsonObject("effect_position"), fire)
                                    && flint.level().getBlockState(fire).is(Blocks.FIRE)
                                    // Generic face selection returns what actually happened; it
                                    // does not promise the caller's preferred portal interior cell.
                                    && (fire.equals(portalInteriorCandidate)
                                    || flint.level().getBlockState(portalInteriorCandidate).isAir())
                                    && data(result).get("durability_used").getAsInt() == 1
                                    && data(result).get("consumed_count").getAsInt() == 0,
                            "flint-and-steel effect was not verified exactly: " + flintTerminal.get());
                    assertInventory(helper, flint, Items.FLINT_AND_STEEL, 5, 1, 1,
                            Items.TORCH, false);
                    call(frame, "item-eye", "minecraft:ender_eye", eyeTerminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(eyeTerminal.get() != null,
                        "use_item_on_block Ender Eye call did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(eyeTerminal.get());
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && "target_block_changed".equals(data(result).get("outcome").getAsString())
                                    && positionEquals(data(result).getAsJsonObject("effect_position"), frame.target())
                                    && frame.level().getBlockState(frame.target()).getValue(EndPortalFrameBlock.HAS_EYE)
                                    && data(result).get("consumed_count").getAsInt() == 1
                                    && data(result).get("durability_used").getAsInt() == 0,
                            "End Portal Frame Eye insertion was not verified: " + eyeTerminal.get());
                    assertSlot(helper, frame, 6, Items.ENDER_EYE, 1, 0);
                    assertMainBody(helper, frame, Items.DIAMOND_AXE, Items.TORCH, 0, false);
                    cleanup(flint);
                })
                .thenSucceed();
    }

    public static void failures_are_typed_isolated_and_restored(GameTestHelper helper) {
        Fixture stone = fixture(helper, Blocks.STONE.defaultBlockState(), 52L);
        Fixture changed = stone.withTarget(stone.target().north(2));
        Fixture reach = stone.withTarget(stone.target().south(2));
        Fixture occluded = stone.withTarget(stone.target().south(4));
        setTarget(changed, Blocks.STONE.defaultBlockState());
        setTarget(reach, Blocks.STONE.defaultBlockState());
        setTarget(occluded, Blocks.STONE.defaultBlockState());
        prepareInventory(stone, Items.STICK, 5, Items.FLINT_AND_STEEL, true);
        stone.bot().getInventory().setItem(7, new ItemStack(Items.COBBLESTONE));
        bind(stone, changed, reach, occluded);
        AtomicReference<String> noEffect = new AtomicReference<>();
        AtomicReference<String> unsupported = new AtomicReference<>();
        AtomicReference<String> missing = new AtomicReference<>();
        AtomicReference<String> mismatch = new AtomicReference<>();
        AtomicReference<String> outOfReach = new AtomicReference<>();
        AtomicReference<String> blocked = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(stone, "item-no-effect", "minecraft:stick", noEffect))
                .thenWaitUntil(() -> helper.assertTrue(noEffect.get() != null,
                        "use_item_on_block no-effect call did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, noEffect.get(), "no_effect");
                    helper.assertTrue(!stone.level().getBlockState(stone.target().west()).is(Blocks.FIRE),
                            "use_item_on_block fell back to the flint-and-steel offhand");
                    assertInventory(helper, stone, Items.STICK, 5, 1, 0,
                            Items.FLINT_AND_STEEL, true);
                    call(stone, "item-block", "minecraft:cobblestone", unsupported);
                })
                .thenWaitUntil(() -> helper.assertTrue(unsupported.get() != null,
                        "use_item_on_block BlockItem rejection did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, unsupported.get(), "item_not_supported");
                    assertMainBody(helper, stone, Items.DIAMOND_AXE, Items.FLINT_AND_STEEL, 0, true);
                    call(stone, "item-missing", "minecraft:shears", missing);
                })
                .thenWaitUntil(() -> helper.assertTrue(missing.get() != null,
                        "use_item_on_block missing-item rejection did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, missing.get(), "item_not_found");
                    RuntimeKnowledgeFixtures.publishBlock(changed.level().getServer(),
                            changed.level().dimension().location().toString(),
                            changed.level().getGameTime(), changed.target(),
                            changed.level().getBlockState(changed.target()), BlockEvidenceSource.MISMATCH);
                    setTarget(changed, Blocks.DIRT.defaultBlockState());
                    call(changed, "item-changed", "minecraft:stick", mismatch);
                })
                .thenWaitUntil(() -> helper.assertTrue(mismatch.get() != null,
                        "use_item_on_block changed-target rejection did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, mismatch.get(), "target_changed");
                    stone.bot().moveTo(reach.target().getX() - 9.5,
                            reach.target().getY() - 1, reach.target().getZ() + 0.5,
                            -90.0F, 0.0F);
                    call(reach, "item-reach", "minecraft:stick", outOfReach);
                })
                .thenWaitUntil(() -> helper.assertTrue(outOfReach.get() != null,
                        "use_item_on_block reach rejection did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, outOfReach.get(), "out_of_reach");
                    assertInventory(helper, stone, Items.STICK, 5, 1, 0,
                            Items.FLINT_AND_STEEL, true);
                    BlockPos feet = stone.target().west(2).below();
                    stone.bot().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    for (net.minecraft.core.Direction direction : net.minecraft.core.Direction.values()) {
                        stone.level().setBlockAndUpdate(occluded.target().relative(direction),
                                Blocks.OBSIDIAN.defaultBlockState());
                    }
                    setTarget(occluded, Blocks.STONE.defaultBlockState());
                    call(occluded, "item-occluded", "minecraft:stick", blocked);
                })
                .thenWaitUntil(() -> helper.assertTrue(blocked.get() != null,
                        "use_item_on_block occlusion rejection did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, blocked.get(), "occluded");
                    assertInventory(helper, stone, Items.STICK, 5, 1, 0,
                            Items.FLINT_AND_STEEL, true);
                    cleanup(stone);
                })
                .thenSucceed();
    }

    public static void interruption_and_timeout_restore_exact_item_layout(GameTestHelper helper) {
        Fixture fixture = fixture(helper, Blocks.OBSIDIAN.defaultBlockState(), 53L);
        prepareInventory(fixture, Items.FLINT_AND_STEEL, 5, Items.TORCH, false);
        bind(fixture);
        AtomicReference<String> terminal = new AtomicReference<>();
        boolean[] cancelled = new boolean[1];
        var partialId = JsonParser.parseString("\"item-partial-cancel\"");

        helper.startSequence()
                .thenExecute(() -> {
                    fixture.tools().call(partialId, "use_item_on_block",
                            args("minecraft:flint_and_steel", fixture.target()), terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(
                        fixture.bot().getMainHandItem().is(Items.FLINT_AND_STEEL)
                                && fixture.bot().getMainHandItem().getDamageValue() == 1,
                        "use_item_on_block did not expose a post-dispatch cancellation window"))
                .thenExecute(() -> cancelled[0] = fixture.tools().cancel(partialId))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "use_item_on_block partial cancellation did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    helper.assertTrue(cancelled[0] && !result.get("success").getAsBoolean()
                                    && result.get("interrupted").getAsBoolean()
                                    && data(result).get("durability_used").getAsInt() == 1
                                    && data(result).get("consumed_count").getAsInt() == 0
                                    && data(result).has("face"),
                            "use_item_on_block lost verified partial facts: " + terminal.get());
                    assertInventory(helper, fixture, Items.FLINT_AND_STEEL,
                            5, 1, 1, Items.TORCH, false);
                    for (net.minecraft.core.Direction direction
                            : net.minecraft.core.Direction.values()) {
                        BlockPos adjacent = fixture.target().relative(direction);
                        if (fixture.level().getBlockState(adjacent).is(Blocks.FIRE)) {
                            fixture.level().setBlockAndUpdate(adjacent, Blocks.AIR.defaultBlockState());
                        }
                    }
                    setTarget(fixture, Blocks.STONE.defaultBlockState());
                    fixture.bot().getInventory().setItem(5, new ItemStack(Items.STICK));
                    bind(fixture);
                    terminal.set(null);
                    JsonObject args = args("minecraft:stick", fixture.target());
                    var id = JsonParser.parseString("\"item-cancel\"");
                    fixture.tools().call(id, "use_item_on_block", args, terminal::set);
                    cancelled[0] = fixture.tools().cancel(id);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "use_item_on_block cancellation did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    helper.assertTrue(cancelled[0] && !result.get("success").getAsBoolean()
                                    && result.get("interrupted").getAsBoolean(),
                            "use_item_on_block did not return interrupted cancellation: " + terminal.get());
                    assertInventory(helper, fixture, Items.STICK, 5, 1, 0, Items.TORCH, false);
                    terminal.set(null);
                    fixture.tools().call(JsonParser.parseString("\"item-timeout\""),
                            "use_item_on_block", args("minecraft:stick", fixture.target()), terminal::set);
                    ((net.minecraft.world.level.storage.ServerLevelData) fixture.level().getLevelData())
                            .setGameTime(fixture.level().getGameTime() + 601L);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "use_item_on_block timeout did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && result.get("timed_out").getAsBoolean(),
                            "use_item_on_block did not return timeout: " + terminal.get());
                    assertInventory(helper, fixture, Items.STICK, 5, 1, 0, Items.TORCH, false);
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
                feet.offset(-2, -2, -5), feet.offset(5, 4, 5))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
        level.setBlockAndUpdate(target.below(), Blocks.STONE.defaultBlockState());
        level.setBlockAndUpdate(target, targetState);
        bot.getInventory().clearContent();
        bot.setItemInHand(InteractionHand.OFF_HAND, ItemStack.EMPTY);
        bot.setHealth(bot.getMaxHealth());
        bot.fallDistance = 0.0F;
        bot.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, -90.0F, 0.0F);
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(session);
        return new Fixture(level, bot, target, tools);
    }

    private static void prepareInventory(Fixture fixture, Item requested, int source,
                                         Item offhand, boolean sneaking) {
        fixture.bot().getInventory().setItem(0, new ItemStack(Items.DIAMOND_AXE));
        fixture.bot().getInventory().selected = 0;
        fixture.bot().getInventory().setItem(source, new ItemStack(requested));
        fixture.bot().setItemInHand(InteractionHand.OFF_HAND, new ItemStack(offhand));
        fixture.bot().setShiftKeyDown(sneaking);
    }

    private static void bind(Fixture... fixtures) {
        RuntimeBotManager.tick(fixtures[0].level().getServer());
        for (Fixture fixture : fixtures) {
            RuntimeKnowledgeFixtures.publishBlock(fixture.level().getServer(),
                    fixture.level().dimension().location().toString(), fixture.level().getGameTime(),
                    fixture.target(), fixture.level().getBlockState(fixture.target()),
                    BlockEvidenceSource.MISMATCH);
        }
    }

    private static void call(Fixture fixture, String id, String itemId,
                             AtomicReference<String> terminal) {
        fixture.tools().call(JsonParser.parseString('"' + id + '"'),
                "use_item_on_block", args(itemId, fixture.target()), terminal::set);
    }

    private static JsonObject args(String itemId, BlockPos target) {
        JsonObject args = new JsonObject();
        args.addProperty("item_id", itemId);
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

    private static JsonObject result(String terminal) {
        return JsonParser.parseString(terminal).getAsJsonObject();
    }

    private static JsonObject data(JsonObject result) {
        return result.getAsJsonObject("data");
    }

    private static void assertFailure(GameTestHelper helper, String terminal, String expected) {
        JsonObject result = result(terminal);
        helper.assertTrue(!result.get("success").getAsBoolean()
                        && expected.equals(data(result).get("failure_type").getAsString()),
                "use_item_on_block did not return " + expected + ": " + terminal);
    }

    private static void assertInventory(GameTestHelper helper, Fixture fixture, Item item,
                                        int slot, int count, int damage, Item offhand,
                                        boolean sneaking) {
        assertSlot(helper, fixture, slot, item, count, damage);
        assertMainBody(helper, fixture, Items.DIAMOND_AXE, offhand, 0, sneaking);
    }

    private static void assertSlot(GameTestHelper helper, Fixture fixture, int slot,
                                   Item item, int count, int damage) {
        ItemStack stack = fixture.bot().getInventory().getItem(slot);
        helper.assertTrue(stack.is(item) && stack.getCount() == count
                        && stack.getDamageValue() == damage,
                "use_item_on_block did not preserve the exact requested-item slot and mutation");
    }

    private static void assertMainBody(GameTestHelper helper, Fixture fixture, Item main,
                                       Item offhand, int selected, boolean sneaking) {
        helper.assertTrue(fixture.bot().getMainHandItem().is(main)
                        && fixture.bot().getOffhandItem().is(offhand)
                        && fixture.bot().getInventory().selected == selected
                        && fixture.bot().isShiftKeyDown() == sneaking,
                "use_item_on_block leaked hand, slot, offhand, or sneak state");
    }

    private static boolean positionEquals(JsonObject json, BlockPos position) {
        return json.get("x").getAsInt() == position.getX()
                && json.get("y").getAsInt() == position.getY()
                && json.get("z").getAsInt() == position.getZ();
    }

    private static void cleanup(Fixture fixture) {
        fixture.bot().closeContainer();
        fixture.bot().getInventory().clearContent();
        fixture.bot().setItemInHand(InteractionHand.OFF_HAND, ItemStack.EMPTY);
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
