package dev.mcagent.runtime.core.gametest;

import dev.mcagent.runtime.core.act.Ballistics;
import dev.mcagent.runtime.core.pathing.cache.EmbodiedNavView;
import dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority;
import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.evidence.BlockEvidenceStore;
import dev.mcagent.runtime.evidence.BlockObservation;
import dev.mcagent.runtime.sdk.DefaultRuntimeToolGateway;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.gametest.framework.StructureUtils;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

import java.util.ArrayList;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

@GameTestHolder("mc_agent_action_knowledge")
@PrefixGameTestTemplate(false)
public final class ActionKnowledgeGameTests {
    static {
        String dir = System.getProperty("mc_agent.gametest.structures");
        if (dir != null) StructureUtils.testStructuresDir = dir;
    }

    @GameTest(templateNamespace = "mc_agent_placement_context", template = "empty_36x10x20",
            timeoutTicks = 100, batch = "knowledge_arrow")
    public static void arrow_prediction_ignores_hidden_blocks_and_entities(GameTestHelper helper) {
        Fixture f = fixture(helper);
        var target = EntityType.ARMOR_STAND.create(f.level());
        target.moveTo(Vec3.atBottomCenterOf(f.start().east(12)));
        target.setNoGravity(true);
        f.level().addFreshEntity(target);
        Set<UUID> visible = Set.of(target.getUUID());
        BlockEvidenceStore store = new BlockEvidenceStore();
        var view = new EmbodiedNavView(store.snapshot(f.dimension(), f.start(), 32),
                f.level().getMinBuildHeight(), f.level().getHeight());
        Ballistics.Aim baseline = shot(view, f.bot(), target, visible);
        helper.assertTrue(baseline != null, "open arrow fixture has no shot");

        var hidden = EntityType.GHAST.create(f.level());
        hidden.moveTo(Vec3.atBottomCenterOf(f.start().east(6).below()));
        hidden.setNoAi(true);
        hidden.setNoGravity(true);
        f.level().addFreshEntity(hidden);
        helper.assertTrue(baseline.equals(shot(view, f.bot(), target, visible)),
                "unknown entity changed the arrow prediction");
        helper.assertTrue(shot(view, f.bot(), target, Set.of(target.getUUID(), hidden.getUUID())) == null,
                "visible blocking entity did not block the prediction");
        hidden.discard();

        var wall = new ArrayList<BlockObservation>();
        for (BlockPos position : BlockPos.betweenClosed(
                f.start().offset(6, -1, -3), f.start().offset(6, 8, 3))) {
            f.level().setBlockAndUpdate(position, Blocks.STONE.defaultBlockState());
            wall.add(BlockObservation.of(position, Blocks.STONE.defaultBlockState(),
                    BlockEvidenceSource.MISMATCH));
        }
        helper.assertTrue(baseline.equals(shot(view, f.bot(), target, visible)),
                "hidden wall changed the arrow prediction");
        store.publishFrame(f.dimension(), 1L, wall);
        var knownWall = new EmbodiedNavView(store.snapshot(f.dimension(), f.start(), 32),
                f.level().getMinBuildHeight(), f.level().getHeight());
        helper.assertTrue(shot(knownWall, f.bot(), target, visible) == null,
                "known wall did not block the prediction");
        helper.assertTrue(shot(view, f.bot(), target, Set.of()) == null,
                "a target absent from visible knowledge was aimed at");
        target.discard();
        f.close();
        helper.succeed();
    }

    @GameTest(templateNamespace = "mc_agent_placement_context", template = "empty_36x10x20",
            timeoutTicks = 100, batch = "knowledge_remote_placement")
    public static void remote_placement_probe_does_not_detect_hidden_changes(GameTestHelper helper) {
        Fixture f = fixture(helper);
        BlockPos target = f.start().east(10);
        f.publish(target);
        f.publish(target.below());
        var bound = new PhysicalVerificationAuthority.BoundBlock(target,
                RuntimeKnowledgeFixtures.block(f.level().getServer(), f.dimension(), target));
        var action = new PhysicalVerificationAuthority.Place(bound,
                (BlockItem) Items.COBBLESTONE, Items.COBBLESTONE);
        var before = PhysicalVerificationAuthority.probe(f.bot(), action);
        helper.assertTrue(before instanceof PhysicalVerificationAuthority.Unavailable unavailable
                        && unavailable.failure().code() == PhysicalVerificationAuthority.FailureCode.OUT_OF_REACH,
                "remote fixture did not report out_of_reach: " + before);
        f.level().setBlockAndUpdate(target, Blocks.OBSIDIAN.defaultBlockState());
        f.level().setBlockAndUpdate(target.below(), Blocks.AIR.defaultBlockState());
        helper.assertTrue(before.equals(PhysicalVerificationAuthority.probe(f.bot(), action)),
                "remote target/support mutation changed the probe result");
        helper.assertTrue(RuntimeKnowledgeFixtures.block(f.level().getServer(), f.dimension(), target)
                        .state() == BlockEvidenceCell.State.KNOWN_AIR,
                "remote probe published a hidden target change");
        f.close();
        helper.succeed();
    }

    @GameTest(templateNamespace = "mc_agent_placement_context", template = "empty_36x10x20",
            timeoutTicks = 900, batch = "knowledge_unknown_place")
    public static void unknown_target_is_approached_then_placed(GameTestHelper helper) {
        unknownTarget(helper, false);
    }

    @GameTest(templateNamespace = "mc_agent_placement_context", template = "empty_36x10x20",
            timeoutTicks = 900, batch = "knowledge_unknown_occupied")
    public static void unknown_occupied_target_is_refused_after_observation(GameTestHelper helper) {
        unknownTarget(helper, true);
    }

    @GameTest(templateNamespace = "mc_agent_placement_context", template = "empty_36x10x20",
            timeoutTicks = 300, batch = "knowledge_multicell_placement")
    public static void native_bed_and_door_footprints_remain_exact(GameTestHelper helper) {
        Fixture f = fixture(helper);
        BlockPos bed = f.start().east(2);
        BlockPos door = bed.north(3);
        for (BlockPos position : BlockPos.betweenClosed(f.start().offset(-3, -1, -5),
                f.start().offset(5, 3, 3))) f.publish(position);
        f.bot().getInventory().setItem(0, new ItemStack(Items.WHITE_BED, 2));
        f.bot().getInventory().setItem(1, new ItemStack(Items.OAK_DOOR, 2));
        AtomicReference<String> placedBed = new AtomicReference<>();
        AtomicReference<String> placedDoor = new AtomicReference<>();
        f.call("place_block", "minecraft:white_bed", bed, placedBed);
        helper.startSequence()
                .thenWaitUntil(() -> helper.assertTrue(placedBed.get() != null, "bed placement pending"))
                .thenExecute(() -> {
                    assertFootprint(helper, placedBed.get());
                    f.call("place_block", "minecraft:oak_door", door, placedDoor);
                })
                .thenWaitUntil(() -> helper.assertTrue(placedDoor.get() != null, "door placement pending"))
                .thenExecute(() -> {
                    assertFootprint(helper, placedDoor.get());
                    helper.assertTrue(f.bot().getInventory().countItem(Items.WHITE_BED) == 1
                                    && f.bot().getInventory().countItem(Items.OAK_DOOR) == 1
                                    && f.level().getBlockState(bed).is(Blocks.WHITE_BED)
                                    && f.level().getBlockState(door).is(Blocks.OAK_DOOR)
                                    && f.level().getBlockState(door.above()).is(Blocks.OAK_DOOR),
                            "multi-cell placement changed its footprint or consumption");
                    f.close();
                }).thenSucceed();
    }

    private static void assertFootprint(GameTestHelper helper, String raw) {
        JsonObject result = JsonParser.parseString(raw).getAsJsonObject();
        helper.assertTrue(result.get("success").getAsBoolean()
                        && result.getAsJsonObject("data").getAsJsonArray("placed_blocks").size() == 2,
                "multi-cell placement did not verify both cells: " + raw);
    }

    private static void unknownTarget(GameTestHelper helper, boolean occupied) {
        Fixture f = fixture(helper);
        BlockPos target = f.start().east(10);
        if (occupied) f.level().setBlockAndUpdate(target, Blocks.OBSIDIAN.defaultBlockState());
        for (BlockPos position : BlockPos.betweenClosed(f.start().offset(-2, -1, -2),
                target.offset(2, 2, 2))) {
            if (position.distManhattan(target) > 1) f.publish(position);
        }
        helper.assertTrue(RuntimeKnowledgeFixtures.block(f.level().getServer(), f.dimension(), target)
                        .state() == BlockEvidenceCell.State.UNKNOWN,
                "fixture target was already known");
        AtomicReference<String> approached = new AtomicReference<>();
        AtomicReference<String> placed = new AtomicReference<>();
        f.call("goto_block_placement_pose", target, approached);
        dev.mcagent.runtime.task.BotTickDispatcher.tick(f.level().getServer());
        helper.assertTrue(approached.get() == null, "unknown target was refused before observation");
        helper.assertTrue(RuntimeKnowledgeFixtures.block(f.level().getServer(), f.dimension(), target)
                        .state() == BlockEvidenceCell.State.UNKNOWN,
                "approach planning replaced UNKNOWN with fabricated evidence");
        helper.startSequence()
                .thenWaitUntil(() -> helper.assertTrue(approached.get() != null, "approach pending"))
                .thenExecute(() -> {
                    JsonObject result = JsonParser.parseString(approached.get()).getAsJsonObject();
                    if (occupied) {
                        helper.assertTrue(!result.get("success").getAsBoolean()
                                        && result.getAsJsonObject("data").get("failure_type")
                                                .getAsString().equals("target_occupied"),
                                "observed occupied target was not refused: " + result);
                        placed.set(approached.get());
                    } else {
                        helper.assertTrue(result.get("success").getAsBoolean(),
                                "unknown target approach failed: " + result);
                        helper.assertTrue(f.bot().getX() > f.start().getX() + 1,
                                "remote placement pose succeeded without moving");
                        f.call("place_block", target, placed);
                    }
                })
                .thenWaitUntil(() -> helper.assertTrue(placed.get() != null, "placement pending"))
                .thenExecute(() -> {
                    if (!occupied) {
                        helper.assertTrue(JsonParser.parseString(placed.get()).getAsJsonObject()
                                        .get("success").getAsBoolean()
                                        && f.level().getBlockState(target).is(Blocks.COBBLESTONE),
                                "placement after unknown approach failed: " + placed.get());
                    } else {
                        helper.assertTrue(f.level().getBlockState(target).is(Blocks.OBSIDIAN)
                                        && f.bot().getInventory().countItem(Items.COBBLESTONE) == 4,
                                "occupied target was modified or consumed a block");
                    }
                    f.close();
                }).thenSucceed();
    }

    private static Ballistics.Aim shot(EmbodiedNavView view, BotPlayer bot, Entity target,
                                       Set<UUID> visible) {
        return Ballistics.findArrowShot(view, bot, target, visible, 3.0, 0.05, 0.99, 0.3, 32, true);
    }

    private static Fixture fixture(GameTestHelper helper) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.stop(level.getServer());
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer()).orElseThrow();
        BlockPos start = helper.absolutePos(new BlockPos(4, 4, 4));
        for (BlockPos pos : BlockPos.betweenClosed(start.offset(-3, -2, -5), start.offset(16, 10, 5))) {
            level.setBlockAndUpdate(pos, pos.getY() == start.getY() - 1
                    ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState());
        }
        bot.getInventory().clearContent();
        bot.getInventory().setItem(0, new ItemStack(Items.COBBLESTONE, 4));
        bot.moveTo(Vec3.atBottomCenterOf(start));
        bot.setOnGround(true);
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(730L);
        return new Fixture(level, bot, start, tools);
    }

    private record Fixture(ServerLevel level, BotPlayer bot, BlockPos start, DefaultRuntimeToolGateway tools) {
        String dimension() { return level.dimension().location().toString(); }
        void publish(BlockPos position) {
            RuntimeKnowledgeFixtures.publishBlock(level.getServer(), dimension(), level.getGameTime(),
                    position, level.getBlockState(position), BlockEvidenceSource.MISMATCH);
        }
        void call(String tool, BlockPos target, AtomicReference<String> result) {
            call(tool, "minecraft:cobblestone", target, result);
        }
        void call(String tool, String itemId, BlockPos target, AtomicReference<String> result) {
            JsonObject args = new JsonObject();
            args.addProperty("item_id", itemId);
            JsonObject position = new JsonObject();
            position.addProperty("x", target.getX());
            position.addProperty("y", target.getY());
            position.addProperty("z", target.getZ());
            args.add("position", position);
            tools.call(new com.google.gson.JsonPrimitive(tool), tool, args, result::set);
        }
        void close() {
            tools.sessionClosed(Long.MAX_VALUE);
            RuntimeBotManager.stop(level.getServer());
        }
    }
}
