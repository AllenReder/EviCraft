package dev.mcagent.runtime.gametest;

import dev.mcagent.runtime.core.pathing.settings.ScaffoldMaterials;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.sdk.DefaultRuntimeToolGateway;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

public final class RouteMutationPermissionGameTests {

    private static final int INITIAL_SCAFFOLD_COUNT = 16;

    private RouteMutationPermissionGameTests() {}

    public static void empty_permission_cannot_open_a_closed_door(GameTestHelper helper) {
        Fixture fixture = tunnelFixture(helper, 3501L);
        BlockPos door = fixture.start().east(3);
        installClosedDoor(fixture.level(), door);
        bindFixture(fixture);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> gotoTarget(fixture, List.of(), terminal))
                .thenWaitUntil(() -> terminal(terminal, helper, "empty-permission goto"))
                .thenExecute(() -> {
                    helper.assertTrue(!result(terminal).get("success").getAsBoolean(),
                            "empty permission unexpectedly crossed the closed door: "
                                    + terminal.get());
                    helper.assertTrue(!fixture.level().getBlockState(door).getValue(DoorBlock.OPEN),
                            "empty permission opened the closed door");
                    assertUnconsumed(helper, fixture);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void open_only_permission_opens_a_closed_door(GameTestHelper helper) {
        Fixture fixture = tunnelFixture(helper, 3502L);
        BlockPos door = fixture.start().east(3);
        installClosedDoor(fixture.level(), door);
        bindFixture(fixture);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> gotoTarget(fixture, List.of("OPEN"), terminal))
                .thenWaitUntil(() -> terminal(terminal, helper, "OPEN-only door goto"))
                .thenExecute(() -> {
                    helper.assertTrue(result(terminal).get("success").getAsBoolean(),
                            "OPEN-only goto did not cross the closed door: " + terminal.get());
                    helper.assertTrue(fixture.level().getBlockState(door).getValue(DoorBlock.OPEN),
                            "OPEN-only goto crossed without leaving the door open");
                    assertUnconsumed(helper, fixture);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void open_only_permission_cannot_break_a_required_wall(GameTestHelper helper) {
        Fixture fixture = tunnelFixture(helper, 3503L);
        BlockPos wallLow = fixture.start().east(3);
        fixture.level().setBlockAndUpdate(wallLow, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(wallLow.above(), Blocks.STONE.defaultBlockState());
        bindFixture(fixture);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> gotoTarget(fixture, List.of("OPEN"), terminal))
                .thenWaitUntil(() -> terminal(terminal, helper, "OPEN-only wall goto"))
                .thenExecute(() -> {
                    helper.assertTrue(!result(terminal).get("success").getAsBoolean(),
                            "OPEN-only goto unexpectedly crossed the required wall: "
                                    + terminal.get());
                    helper.assertTrue(fixture.level().getBlockState(wallLow).is(Blocks.STONE)
                                    && fixture.level().getBlockState(wallLow.above()).is(Blocks.STONE),
                            "OPEN-only goto broke the required wall");
                    assertUnconsumed(helper, fixture);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void break_permission_retains_verified_wall_traversal(GameTestHelper helper) {
        Fixture fixture = tunnelFixture(helper, 3504L);
        BlockPos wallLow = fixture.start().east(3);
        fixture.level().setBlockAndUpdate(wallLow, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(wallLow.above(), Blocks.STONE.defaultBlockState());
        bindFixture(fixture);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> gotoTarget(fixture, List.of("BREAK"), terminal))
                .thenWaitUntil(() -> terminal(terminal, helper, "BREAK-only wall goto"))
                .thenExecute(() -> {
                    helper.assertTrue(result(terminal).get("success").getAsBoolean(),
                            "BREAK-only goto did not cross the required wall: " + terminal.get());
                    helper.assertTrue(fixture.level().getBlockState(wallLow).isAir()
                                    || fixture.level().getBlockState(wallLow.above()).isAir(),
                            "BREAK-only goto crossed without breaking the required wall");
                    helper.assertTrue(toolDamage(fixture.bot()) > 0,
                            "BREAK-only goto did not damage the selected mining tool");
                    helper.assertTrue(scaffoldCount(fixture.bot()) == INITIAL_SCAFFOLD_COUNT,
                            "BREAK-only goto consumed Scaffold Material");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void open_only_permission_cannot_bridge_a_required_gap(GameTestHelper helper) {
        Fixture fixture = tunnelFixture(helper, 3505L);
        List<BlockPos> gap = gap(fixture);
        bindFixture(fixture);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> gotoTarget(fixture, List.of("OPEN"), terminal))
                .thenWaitUntil(() -> terminal(terminal, helper, "OPEN-only gap goto"))
                .thenExecute(() -> {
                    helper.assertTrue(!result(terminal).get("success").getAsBoolean(),
                            "OPEN-only goto unexpectedly crossed the required gap: "
                                    + terminal.get());
                    helper.assertTrue(gap.stream().allMatch(position ->
                                    fixture.level().getBlockState(position).isAir()),
                            "OPEN-only goto placed Scaffold Material in the required gap");
                    assertUnconsumed(helper, fixture);
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    public static void place_permission_retains_verified_bridge_traversal(GameTestHelper helper) {
        Fixture fixture = tunnelFixture(helper, 3506L);
        List<BlockPos> gap = gap(fixture);
        bindFixture(fixture);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> gotoTarget(fixture, List.of("PLACE"), terminal))
                .thenWaitUntil(() -> terminal(terminal, helper, "PLACE-only gap goto"))
                .thenExecute(() -> {
                    helper.assertTrue(result(terminal).get("success").getAsBoolean(),
                            "PLACE-only goto did not bridge the required gap: " + terminal.get());
                    helper.assertTrue(gap.stream().anyMatch(position ->
                                    fixture.level().getBlockState(position).is(Blocks.DIRT)),
                            "PLACE-only goto crossed without placing Scaffold Material");
                    helper.assertTrue(scaffoldCount(fixture.bot()) < INITIAL_SCAFFOLD_COUNT,
                            "PLACE-only goto did not consume Scaffold Material");
                    helper.assertTrue(toolDamage(fixture.bot()) == 0,
                            "PLACE-only goto damaged the mining tool");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    private static Fixture tunnelFixture(GameTestHelper helper, long session) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.stop(level.getServer());
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        BlockPos start = helper.absolutePos(new BlockPos(4, 260, 4));
        for (BlockPos position : BlockPos.betweenClosed(
                start.offset(-2, -2, -3), start.offset(10, 4, 3))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        for (int x = -1; x <= 8; x++) {
            BlockPos feet = start.east(x);
            level.setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
            level.setBlockAndUpdate(feet.above(2), Blocks.BEDROCK.defaultBlockState());
            for (int y = 0; y <= 2; y++) {
                level.setBlockAndUpdate(feet.north().above(y), Blocks.BEDROCK.defaultBlockState());
                level.setBlockAndUpdate(feet.south().above(y), Blocks.BEDROCK.defaultBlockState());
            }
        }
        bot.getInventory().clearContent();
        bot.getInventory().setItem(0, new ItemStack(Items.DIAMOND_PICKAXE));
        bot.getInventory().setItem(1, new ItemStack(Items.DIRT, INITIAL_SCAFFOLD_COUNT));
        bot.getInventory().selected = 0;
        ScaffoldMaterials.store(bot, List.of("minecraft:dirt"));
        bot.moveTo(start.getX() + 0.5, start.getY(), start.getZ() + 0.5, -90.0F, 0.0F);
        bot.fallDistance = 0.0F;
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(session);
        return new Fixture(level, bot, start, start.east(7), tools);
    }

    private static void installClosedDoor(ServerLevel level, BlockPos lowerPosition) {
        var lower = Blocks.OAK_DOOR.defaultBlockState()
                .setValue(DoorBlock.FACING, Direction.EAST)
                .setValue(DoorBlock.OPEN, false)
                .setValue(DoorBlock.HALF, DoubleBlockHalf.LOWER);
        level.setBlockAndUpdate(lowerPosition, lower);
        level.setBlockAndUpdate(lowerPosition.above(), lower.setValue(
                DoorBlock.HALF, DoubleBlockHalf.UPPER));
    }

    private static List<BlockPos> gap(Fixture fixture) {
        List<BlockPos> gap = List.of(fixture.start().east(2).below());
        gap.forEach(position -> fixture.level().setBlockAndUpdate(
                position, Blocks.AIR.defaultBlockState()));
        return gap;
    }

    private static void bindFixture(Fixture fixture) {
        RuntimeBotManager.tick(fixture.level().getServer());
        for (BlockPos position : BlockPos.betweenClosed(
                fixture.start().offset(-2, -2, -3), fixture.target().offset(2, 4, 3))) {
            dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.publishBlock(
                    fixture.level().getServer(),
                    fixture.level().dimension().location().toString(),
                    fixture.level().getGameTime(),
                    position,
                    fixture.level().getBlockState(position),
                    BlockEvidenceSource.MISMATCH);
        }
    }

    private static void gotoTarget(
            Fixture fixture, List<String> permissions, AtomicReference<String> terminal) {
        JsonObject args = new JsonObject();
        JsonObject position = new JsonObject();
        position.addProperty("x", fixture.target().getX());
        position.addProperty("y", fixture.target().getY());
        position.addProperty("z", fixture.target().getZ());
        JsonObject goal = new JsonObject();
        goal.addProperty("kind", "cell");
        goal.add("position", position);
        args.add("goal", goal);
        JsonArray values = new JsonArray();
        permissions.forEach(values::add);
        args.add("route_mutation_permissions", values);
        fixture.tools().call(JsonParser.parseString("\"goto-permission\""),
                "goto", args, terminal::set);
    }

    private static boolean terminal(
            AtomicReference<String> terminal, GameTestHelper helper, String label) {
        helper.assertTrue(terminal.get() != null, label + " did not terminate");
        return true;
    }

    private static JsonObject result(AtomicReference<String> terminal) {
        return JsonParser.parseString(terminal.get()).getAsJsonObject();
    }

    private static int scaffoldCount(BotPlayer bot) {
        return bot.getInventory().countItem(Items.DIRT);
    }

    private static int toolDamage(BotPlayer bot) {
        for (int slot = 0; slot < bot.getInventory().getContainerSize(); slot++) {
            ItemStack stack = bot.getInventory().getItem(slot);
            if (stack.is(Items.DIAMOND_PICKAXE)) return stack.getDamageValue();
        }
        return -1;
    }

    private static void assertUnconsumed(
            GameTestHelper helper, Fixture fixture) {
        helper.assertTrue(scaffoldCount(fixture.bot()) == INITIAL_SCAFFOLD_COUNT,
                "navigation consumed Scaffold Material without PLACE permission");
        helper.assertTrue(toolDamage(fixture.bot()) == 0,
                "navigation damaged a tool without BREAK permission");
        helper.assertTrue(ScaffoldMaterials.of(fixture.bot()).contains((Item) Items.DIRT),
                "test fixture lost its explicit Scaffold Material policy");
    }

    private static void cleanup(Fixture fixture) {
        fixture.tools().sessionClosed(Long.MAX_VALUE);
        RuntimeBotManager.stop(fixture.level().getServer());
    }

    private record Fixture(
            ServerLevel level,
            BotPlayer bot,
            BlockPos start,
            BlockPos target,
            DefaultRuntimeToolGateway tools) {}
}
