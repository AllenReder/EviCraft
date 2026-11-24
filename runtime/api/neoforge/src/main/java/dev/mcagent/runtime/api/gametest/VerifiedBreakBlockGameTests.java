package dev.mcagent.runtime.api.gametest;

import dev.mcagent.runtime.entity.BotPlayer;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;
import dev.mcagent.runtime.sdk.DefaultRuntimeToolGateway;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.gametest.framework.StructureUtils;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.GameType;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.animal.IronGolem;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

import java.util.concurrent.atomic.AtomicReference;

/** Contract tests for the break_block primitive adapted by break_block. */
@GameTestHolder("mc_agent_api")
@PrefixGameTestTemplate(false)
public final class VerifiedBreakBlockGameTests {
    private VerifiedBreakBlockGameTests() {}

    static {
        String dir = System.getProperty("mc_agent.gametest.structures");
        if (dir != null) StructureUtils.testStructuresDir = dir;
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 360, batch = "verified_break_observed_drops")
    public static void break_block_reports_actionable_ordinary_drop_entities(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 75L);
        fixture.level().setBlockAndUpdate(fixture.target(), Blocks.DIRT.defaultBlockState());
        bind(fixture, fixture.target());
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "break-observed-drop", fixture.target(), terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "ordinary-drop break did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    JsonObject data = result.getAsJsonObject("data");
                    JsonArray observed = data.getAsJsonArray("observed_drop_entities");
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && samePosition(data.getAsJsonObject("position"), fixture.target())
                                    && observed.size() == 1,
                            "break_block did not report one ordinary drop: " + terminal.get());
                    JsonObject drop = observed.get(0).getAsJsonObject();
                    helper.assertTrue("minecraft:dirt".equals(drop.get("item_id").getAsString())
                                    && drop.get("count").getAsInt() == 1,
                            "break_block reported malformed ordinary drop data: " + terminal.get());
                    ItemEntity entity = fixture.level().getEntity(
                            java.util.UUID.fromString(drop.get("uuid").getAsString()))
                            instanceof ItemEntity item ? item : null;
                    helper.assertTrue(entity != null
                                    && entity.getBoundingBox().intersects(
                                    new AABB(fixture.target()).inflate(2.0)),
                            "break_block drop UUID did not identify the observed entity: "
                                    + terminal.get());
                    JsonArray uuids = new JsonArray();
                    uuids.add(drop.get("uuid").getAsString());
                    JsonObject args = new JsonObject();
                    args.add("uuids", uuids);
                    args.add("radius", JsonNull.INSTANCE);
                    terminal.set(null);
                    fixture.tools().call(JsonParser.parseString("\"collect-break-drop\""),
                            "collect_items", args, terminal::set);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "exact collection of the reported break drop did not terminate"))
                .thenExecute(() -> {
                    JsonObject collectResult = result(terminal.get());
                    helper.assertTrue(collectResult.get("success").getAsBoolean()
                                    && fixture.bot().getInventory().countItem(
                                    net.minecraft.world.item.Items.DIRT) == 1,
                            "break_block reported a drop UUID that collect_items could not use: "
                                    + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 360, batch = "verified_break_drifting_item")
    public static void break_block_does_not_report_an_item_that_drifts_into_the_drop_area(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 85L);
        BlockPos target = fixture.target();
        fixture.level().setBlockAndUpdate(target, Blocks.OAK_LOG.defaultBlockState());
        bind(fixture, target);
        // An older item, as the drop of an earlier break is: outside the drop area when this break begins.
        ItemEntity older = new ItemEntity(fixture.level(),
                target.getX() + 4.5, target.getY() + 0.5, target.getZ() + 0.5,
                new ItemStack(Items.COBBLESTONE), 0.0, 0.0, 0.0);
        older.setNoGravity(true);
        older.setNeverPickUp();
        fixture.level().addFreshEntity(older);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "break-drifting-item", target, terminal))
                // Bare hands take three seconds on a log, so the item arrives while it is mined.
                .thenExecuteAfter(20, () -> {
                    helper.assertTrue(terminal.get() == null
                                    && fixture.level().getBlockState(target).is(Blocks.OAK_LOG),
                            "the log was gone before the older item arrived: " + terminal.get());
                    older.setPos(target.getX() + 1.5, target.getY() + 0.5, target.getZ() + 0.5);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "drifting-item break did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    JsonArray observed = result.getAsJsonObject("data")
                            .getAsJsonArray("observed_drop_entities");
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && !older.isRemoved()
                                    && older.getBoundingBox().intersects(new AABB(target).inflate(1.0))
                                    && observed.size() == 1
                                    && "minecraft:oak_log".equals(observed.get(0)
                                    .getAsJsonObject().get("item_id").getAsString()),
                            "break_block reported an older item as its drop: " + terminal.get());
                    older.discard();
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 360, batch = "verified_break_zero_drops")
    public static void break_block_accepts_verified_zero_drop_success(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 76L);
        fixture.level().setBlockAndUpdate(fixture.target(), Blocks.GLASS.defaultBlockState());
        bind(fixture, fixture.target());
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "break-zero-drop", fixture.target(), terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "zero-drop break did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && samePosition(data.getAsJsonObject("position"), fixture.target())
                                    && data.getAsJsonArray("observed_drop_entities").isEmpty()
                                    && fixture.level().getBlockState(fixture.target()).isAir(),
                            "break_block did not accept verified zero-drop success: "
                                    + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 360, batch = "verified_break_implement_selection")
    public static void break_block_selects_a_suitable_carried_implement(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 79L);
        fixture.level().setBlockAndUpdate(fixture.target(), Blocks.STONE.defaultBlockState());
        fixture.bot().getInventory().selected = 0;
        fixture.bot().getInventory().setItem(0, new ItemStack(Items.STICK));
        fixture.bot().getInventory().setItem(9, new ItemStack(Items.IRON_PICKAXE));
        bind(fixture, fixture.target());
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(
                        fixture, "break-select-implement", fixture.target(), terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "implement-selecting break did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    JsonArray observed = result.getAsJsonObject("data")
                            .getAsJsonArray("observed_drop_entities");
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && fixture.level().getBlockState(fixture.target()).isAir()
                                    && fixture.bot().getMainHandItem().is(Items.IRON_PICKAXE)
                                    && observed.size() == 1
                                    && "minecraft:cobblestone".equals(observed.get(0)
                                    .getAsJsonObject().get("item_id").getAsString()),
                            "break_block did not select and retain the suitable carried implement: "
                                    + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 360, batch = "verified_break_without_correct_implement")
    public static void break_block_continues_without_a_correct_implement(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 80L);
        fixture.level().setBlockAndUpdate(fixture.target(), Blocks.STONE.defaultBlockState());
        fixture.bot().getInventory().selected = 0;
        fixture.bot().getInventory().setItem(0, new ItemStack(Items.STICK));
        bind(fixture, fixture.target());
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(
                        fixture, "break-without-correct-implement", fixture.target(), terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "break without a correct implement did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && fixture.level().getBlockState(fixture.target()).isAir()
                                    && fixture.bot().getMainHandItem().is(Items.STICK)
                                    && result.getAsJsonObject("data")
                                    .getAsJsonArray("observed_drop_entities").isEmpty(),
                            "break_block refused or changed its contract without a correct implement: "
                                    + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 240, batch = "verified_break_validation_hand")
    public static void rejected_break_does_not_select_an_implement(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 81L);
        fixture.level().setBlockAndUpdate(fixture.target(), Blocks.BEDROCK.defaultBlockState());
        fixture.bot().getInventory().selected = 0;
        fixture.bot().getInventory().setItem(0, new ItemStack(Items.STICK));
        fixture.bot().getInventory().setItem(9, new ItemStack(Items.DIAMOND_PICKAXE));
        bind(fixture, fixture.target());
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(
                        fixture, "reject-before-implement-selection", fixture.target(), terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "rejected break did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), fixture.target(), "unbreakable");
                    helper.assertTrue(fixture.bot().getMainHandItem().is(Items.STICK)
                                    && fixture.bot().getInventory().getItem(9)
                                    .is(Items.DIAMOND_PICKAXE),
                            "validation failure selected or moved a Break Implement");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 240, batch = "verified_break_creative_hand")
    public static void creative_break_does_not_select_an_implement(GameTestHelper helper) {
        Fixture fixture = fixture(helper, 82L);
        fixture.level().setBlockAndUpdate(fixture.target(), Blocks.STONE.defaultBlockState());
        fixture.bot().getInventory().selected = 0;
        fixture.bot().getInventory().setItem(0, new ItemStack(Items.STICK));
        fixture.bot().getInventory().setItem(9, new ItemStack(Items.DIAMOND_PICKAXE));
        fixture.bot().setGameMode(GameType.CREATIVE);
        bind(fixture, fixture.target());
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(
                        fixture, "creative-break-without-selection", fixture.target(), terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "creative break did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && fixture.level().getBlockState(fixture.target()).isAir()
                                    && fixture.bot().getMainHandItem().is(Items.STICK)
                                    && fixture.bot().getInventory().getItem(9)
                                    .is(Items.DIAMOND_PICKAXE),
                            "creative break unnecessarily selected a Break Implement: "
                                    + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 360, batch = "verified_break_effects")
    public static void break_block_verifies_exact_disappearance_and_changed_target(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 71L);
        BlockPos neighbour = fixture.target().north();
        BlockPos changed = fixture.target().south(2);
        fixture.level().setBlockAndUpdate(fixture.target(), Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(neighbour, Blocks.GOLD_BLOCK.defaultBlockState());
        fixture.level().setBlockAndUpdate(changed, Blocks.STONE.defaultBlockState());
        bind(fixture, fixture.target(), changed);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "break-exact", fixture.target(), terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "exact break did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && data.size() == 2
                                    && samePosition(data.getAsJsonObject("position"), fixture.target())
                                    && data.getAsJsonArray("observed_drop_entities").isEmpty()
                                    && fixture.level().getBlockState(fixture.target()).isAir()
                                    && fixture.level().getBlockState(neighbour).is(Blocks.GOLD_BLOCK),
                            "break_block did not verify only the exact target: " + terminal.get());
                    moveBeside(fixture, changed);
                    terminal.set(null);
                })
                .thenExecuteAfter(2, () -> {
                    fixture.level().setBlockAndUpdate(changed, Blocks.DIRT.defaultBlockState());
                    call(fixture, "break-changed", changed, terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "changed-target break did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), changed, "target_changed");
                    helper.assertTrue(fixture.level().getBlockState(changed).is(Blocks.DIRT),
                            "changed target was physically modified");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 360, batch = "verified_break_visible_outline")
    public static void break_block_uses_visible_outline_when_cell_center_is_occluded(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 74L);
        BlockPos target = fixture.target().west().below();
        BlockPos blocker = target.above();
        fixture.level().setBlockAndUpdate(target, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(blocker, Blocks.OBSIDIAN.defaultBlockState());
        bind(fixture, target, blocker);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "break-visible-outline", target, terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "visible-outline break did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    helper.assertTrue(result.get("success").getAsBoolean()
                                    && fixture.level().getBlockState(target).isAir()
                                    && fixture.level().getBlockState(blocker).is(Blocks.OBSIDIAN),
                            "break_block did not use the visible target outline: "
                                    + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 520, batch = "verified_break_failures")
    public static void break_block_returns_closed_menu_evidence_reach_occlusion_and_effect_failures(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 72L);
        BlockPos chest = fixture.target();
        BlockPos breakTarget = chest.south(2);
        BlockPos reachTarget = chest.south(4);
        BlockPos occluded = chest.south(6);
        BlockPos bedrock = chest.south(8);
        BlockPos noEffect = chest.south(10);
        BlockPos midOccluded = chest.south(12);
        fixture.level().setBlockAndUpdate(chest, Blocks.CHEST.defaultBlockState());
        fixture.level().setBlockAndUpdate(breakTarget, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(reachTarget, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(occluded, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(bedrock, Blocks.BEDROCK.defaultBlockState());
        fixture.level().setBlockAndUpdate(noEffect, Blocks.STONE.defaultBlockState());
        fixture.level().setBlockAndUpdate(midOccluded, Blocks.OBSIDIAN.defaultBlockState());
        bind(fixture, chest, breakTarget, reachTarget, occluded, bedrock, noEffect, midOccluded);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> fixture.tools().call(JsonParser.parseString("\"open-break-menu\""),
                        "activate_block", positionArgs(chest), terminal::set))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "menu setup did not terminate"))
                .thenExecute(() -> {
                    helper.assertTrue(result(terminal.get()).get("success").getAsBoolean(),
                            "menu setup failed: " + terminal.get());
                    terminal.set(null);
                    call(fixture, "break-menu-open", breakTarget, terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "menu-open break did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), breakTarget, "menu_open");
                    fixture.bot().closeContainer();
                    BlockPos unknown = chest.east(24);
                    fixture.level().setBlockAndUpdate(unknown, Blocks.STONE.defaultBlockState());
                    terminal.set(null);
                    call(fixture, "break-unknown", unknown, terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "unknown-target break did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), chest.east(24),
                            "target_not_known_block");
                    fixture.bot().moveTo(reachTarget.getX() - 10.5, reachTarget.getY() - 1,
                            reachTarget.getZ() + 0.5, -90.0F, 0.0F);
                    terminal.set(null);
                    call(fixture, "break-reach", reachTarget, terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "out-of-reach break did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), reachTarget, "out_of_reach");
                    BlockPos feet = occluded.west(2).below();
                    fixture.level().setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
                    fixture.level().setBlockAndUpdate(occluded.west(), Blocks.OBSIDIAN.defaultBlockState());
                    fixture.bot().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                            -90.0F, 0.0F);
                    terminal.set(null);
                    call(fixture, "break-occluded", occluded, terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "occluded break did not terminate"))
                .thenExecute(() -> {
                    BlockPos blocker = occluded.west();
                    assertOccludedByBlock(helper, terminal.get(), occluded, blocker,
                            "minecraft:obsidian");
                    BlockEvidenceCell blockerEvidence = RuntimeKnowledgeFixtures.block(
                            fixture.level().getServer(),
                            fixture.level().dimension().location().toString(), blocker);
                    helper.assertTrue(blockerEvidence.state() == BlockEvidenceCell.State.KNOWN_BLOCK
                                    && "minecraft:obsidian".equals(blockerEvidence.blockState()),
                            "occluding block was not admitted into embodied evidence");
                    moveBeside(fixture, bedrock);
                    terminal.set(null);
                    call(fixture, "break-bedrock", bedrock, terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "unbreakable break did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), bedrock, "unbreakable");
                    fixture.bot().setGameMode(GameType.ADVENTURE);
                    moveBeside(fixture, noEffect);
                    terminal.set(null);
                    call(fixture, "break-no-effect", noEffect, terminal);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "no-effect break did not terminate"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), noEffect, "no_effect");
                    helper.assertTrue(fixture.level().getBlockState(noEffect).is(Blocks.STONE),
                            "no-effect target unexpectedly disappeared");
                    fixture.bot().setGameMode(GameType.SURVIVAL);
                    moveBeside(fixture, midOccluded);
                    terminal.set(null);
                })
                .thenExecuteAfter(2, () -> call(
                        fixture, "break-mid-occlusion", midOccluded, terminal))
                .thenExecuteAfter(3, () -> fixture.level().setBlockAndUpdate(
                        midOccluded.west(), Blocks.OBSIDIAN.defaultBlockState()))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "mid-break occlusion did not terminate"))
                .thenExecute(() -> {
                    assertOccludedByBlock(helper, terminal.get(), midOccluded,
                            midOccluded.west(), "minecraft:obsidian");
                    helper.assertTrue(fixture.level().getBlockState(midOccluded).is(Blocks.OBSIDIAN)
                                    && fixture.level().getBlockState(midOccluded.west())
                                    .is(Blocks.OBSIDIAN),
                            "mid-break occlusion destroyed the exact target or alternate blocker");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 240, batch = "verified_break_entity_occlusion")
    public static void break_block_entity_occlusion_does_not_fabricate_occluding_block(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 77L);
        BlockPos target = fixture.target();
        fixture.level().setBlockAndUpdate(target, Blocks.STONE.defaultBlockState());
        bind(fixture, target);
        IronGolem blocker = EntityType.IRON_GOLEM.create(fixture.level());
        helper.assertTrue(blocker != null, "iron golem fixture did not create");
        blocker.moveTo(target.getX() - 0.5, target.getY() - 1.0, target.getZ() + 0.5);
        fixture.level().addFreshEntity(blocker);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "break-entity-occluded", target, terminal))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "entity-occluded break did not terminate"))
                .thenExecute(() -> {
                    JsonObject data = result(terminal.get()).getAsJsonObject("data");
                    helper.assertTrue(!result(terminal.get()).get("success").getAsBoolean()
                                    && "occluded".equals(data.get("failure_type").getAsString())
                                    && !data.has("occluding_block")
                                    && fixture.level().getBlockState(target).is(Blocks.STONE),
                            "entity first hit fabricated a block occlusion result: " + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 240, batch = "verified_break_miss_occlusion")
    public static void break_block_ray_miss_reaims_without_fabricating_occluding_block(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 78L);
        BlockPos target = fixture.target();
        fixture.level().setBlockAndUpdate(target, Blocks.OBSIDIAN.defaultBlockState());
        fixture.bot().moveTo(target.getX() + 0.49609593591668,
                target.getY() - 0.46415937495544,
                target.getZ() + 1.30000001192093, 0.0F, 0.0F);
        bind(fixture, target);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "break-ray-miss", target, terminal))
                // Dropping the eye below the top face loses the original aim point; the dig must
                // re-aim at the still-visible south face instead of failing.
                .thenExecuteAfter(1, () -> fixture.bot().moveTo(
                        target.getX() + 0.49609593591668, target.getY() - 1.0,
                        target.getZ() + 1.30000001192093, 0.0F, 0.0F))
                .thenExecuteAfter(6, () -> {
                    helper.assertTrue(terminal.get() == null,
                            "a lost aim point ended the break instead of re-aiming: "
                                    + terminal.get());
                    fixture.bot().moveTo(target.getX() + 0.5, target.getY() - 1.0,
                            target.getZ() + 9.5, 0.0F, 0.0F);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "out-of-reach break did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(!result.get("success").getAsBoolean()
                                    && "out_of_reach".equals(data.get("failure_type").getAsString())
                                    && !data.has("occluding_block")
                                    && fixture.level().getBlockState(target).is(Blocks.OBSIDIAN),
                            "a lost aim point fabricated an occlusion or broke the target: "
                                    + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 360, batch = "verified_break_occlusion_restart")
    public static void break_block_restarts_from_zero_after_a_brief_occlusion(
            GameTestHelper helper) {
        // Oak planks by hand take 60 ticks. A client that loses sight of the block aborts the
        // dig, so a 4-tick occlusion after 30 ticks must cost the full 60 ticks again.
        Fixture fixture = fixture(helper, 83L);
        BlockPos target = fixture.target();
        BlockPos occluder = target.west();
        fixture.level().setBlockAndUpdate(target, Blocks.OAK_PLANKS.defaultBlockState());
        bind(fixture, target);
        AtomicReference<String> terminal = new AtomicReference<>();
        long[] started = new long[1];
        long[] occlusionCleared = new long[1];

        helper.startSequence()
                .thenExecute(() -> {
                    started[0] = fixture.level().getGameTime();
                    call(fixture, "break-occlusion-restart", target, terminal);
                })
                .thenExecuteAfter(30, () -> fixture.level().setBlockAndUpdate(
                        occluder, Blocks.OBSIDIAN.defaultBlockState()))
                .thenExecuteAfter(4, () -> {
                    helper.assertTrue(terminal.get() == null,
                            "a brief occlusion ended the break: " + terminal.get());
                    fixture.level().setBlockAndUpdate(occluder, Blocks.AIR.defaultBlockState());
                    occlusionCleared[0] = fixture.level().getGameTime();
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "break did not resume after the occlusion cleared"))
                .thenExecute(() -> {
                    long sinceCleared = fixture.level().getGameTime() - occlusionCleared[0];
                    helper.assertTrue(result(terminal.get()).get("success").getAsBoolean()
                                    && fixture.level().getBlockState(target).isAir(),
                            "break did not finish after the occlusion cleared: " + terminal.get());
                    helper.assertTrue(sinceCleared >= 58,
                            "dig kept progress across the occlusion (finished " + sinceCleared
                                    + " ticks after it cleared, total "
                                    + (fixture.level().getGameTime() - started[0]) + ")");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 240, batch = "verified_break_reach_limit")
    public static void break_block_stops_once_no_point_is_within_client_reach(
            GameTestHelper helper) {
        // Obsidian by hand never finishes here. Moving the eye to 5 blocks from the target's
        // face is inside the server's reach+1 tolerance but beyond a client's crosshair reach.
        Fixture fixture = fixture(helper, 84L);
        BlockPos target = fixture.target();
        fixture.level().setBlockAndUpdate(target, Blocks.OBSIDIAN.defaultBlockState());
        bind(fixture, target);
        AtomicReference<String> terminal = new AtomicReference<>();

        helper.startSequence()
                .thenExecute(() -> call(fixture, "break-reach-limit", target, terminal))
                .thenExecuteAfter(5, () -> {
                    helper.assertTrue(terminal.get() == null,
                            "break ended before the body moved: " + terminal.get());
                    fixture.bot().moveTo(target.getX() - 5.0, target.getY() - 1,
                            target.getZ() + 0.5, -90.0F, 0.0F);
                    fixture.bot().setOnGround(true);
                })
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "break kept going beyond client reach"))
                .thenExecute(() -> {
                    assertFailure(helper, terminal.get(), target, "out_of_reach");
                    helper.assertTrue(fixture.level().getBlockState(target).is(Blocks.OBSIDIAN),
                            "out-of-reach break changed its target");
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    @GameTest(templateNamespace = "mc_agent_verified_break", template = "empty_36x10x20",
            timeoutTicks = 240, batch = "verified_break_interruption")
    public static void break_block_interruption_keeps_only_verified_position(
            GameTestHelper helper) {
        Fixture fixture = fixture(helper, 73L);
        fixture.level().setBlockAndUpdate(fixture.target(), Blocks.OBSIDIAN.defaultBlockState());
        fixture.bot().getInventory().selected = 0;
        fixture.bot().getInventory().setItem(0, new ItemStack(Items.STICK));
        fixture.bot().getInventory().setItem(9, new ItemStack(Items.IRON_PICKAXE));
        bind(fixture, fixture.target());
        AtomicReference<String> terminal = new AtomicReference<>();
        AtomicReference<JsonElement> callId = new AtomicReference<>();
        boolean[] cancelled = new boolean[1];

        helper.startSequence()
                .thenExecute(() -> {
                    var id = JsonParser.parseString("\"break-cancel\"");
                    callId.set(id);
                    fixture.tools().call(id, "break_block", positionArgs(fixture.target()), terminal::set);
                })
                .thenExecuteAfter(3, () -> cancelled[0] = fixture.tools().cancel(callId.get()))
                .thenWaitUntil(() -> helper.assertTrue(terminal.get() != null,
                        "cancelled break did not terminate"))
                .thenExecute(() -> {
                    JsonObject result = result(terminal.get());
                    JsonObject data = result.getAsJsonObject("data");
                    helper.assertTrue(cancelled[0] && !result.get("success").getAsBoolean()
                                    && result.get("interrupted").getAsBoolean()
                                    && data.size() == 1
                                    && samePosition(data.getAsJsonObject("position"), fixture.target())
                                    && fixture.level().getBlockState(fixture.target()).is(Blocks.OBSIDIAN)
                                    && fixture.bot().getMainHandItem().is(Items.IRON_PICKAXE),
                            "interrupted break leaked fields or changed its target: " + terminal.get());
                    cleanup(fixture);
                })
                .thenSucceed();
    }

    private static Fixture fixture(GameTestHelper helper, long session) {
        ServerLevel level = helper.getLevel();
        RuntimeBotManager.stop(level.getServer());
        RuntimeBotManager.create(level.getServer(), "bot");
        BotPlayer bot = RuntimeBotManager.current(level.getServer())
                .orElseThrow(() -> new AssertionError("Runtime Bot was not created"));
        BlockPos feet = helper.absolutePos(new BlockPos(4, 4, 4));
        BlockPos target = feet.east(2).above();
        for (BlockPos position : BlockPos.betweenClosed(
                feet.offset(-3, -2, -3), feet.offset(28, 4, 14))) {
            level.setBlockAndUpdate(position, Blocks.AIR.defaultBlockState());
        }
        for (BlockPos floor : BlockPos.betweenClosed(
                feet.offset(-3, -1, -3), feet.offset(28, -1, 14))) {
            level.setBlockAndUpdate(floor, Blocks.STONE.defaultBlockState());
        }
        bot.getInventory().clearContent();
        bot.setHealth(bot.getMaxHealth());
        bot.fallDistance = 0.0F;
        bot.setGameMode(GameType.SURVIVAL);
        bot.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, -90.0F, 0.0F);
        DefaultRuntimeToolGateway tools = new DefaultRuntimeToolGateway(() -> bot);
        tools.sessionOpened(session);
        return new Fixture(level, bot, target, tools);
    }

    private static void bind(Fixture fixture, BlockPos... targets) {
        RuntimeBotManager.tick(fixture.level().getServer());
        for (BlockPos target : targets) {
            RuntimeKnowledgeFixtures.publishBlock(
                    fixture.level().getServer(),
                    fixture.level().dimension().location().toString(),
                    fixture.level().getGameTime(), target,
                    fixture.level().getBlockState(target), BlockEvidenceSource.MISMATCH);
        }
    }

    private static void call(Fixture fixture, String id, BlockPos target,
                             AtomicReference<String> terminal) {
        // GameTest fixture teleports and dispatches in one server tick; freeze the body fact
        // that the next ordinary entity tick would derive from the support block below.
        fixture.bot().setOnGround(true);
        fixture.tools().call(JsonParser.parseString('"' + id + '"'),
                "break_block", positionArgs(target), terminal::set);
    }

    private static JsonObject positionArgs(BlockPos target) {
        JsonObject args = new JsonObject();
        JsonObject position = new JsonObject();
        position.addProperty("x", target.getX());
        position.addProperty("y", target.getY());
        position.addProperty("z", target.getZ());
        args.add("position", position);
        return args;
    }

    private static void moveBeside(Fixture fixture, BlockPos target) {
        BlockPos feet = target.west(2).below();
        fixture.level().setBlockAndUpdate(feet.below(), Blocks.STONE.defaultBlockState());
        fixture.bot().moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5,
                -90.0F, 0.0F);
        fixture.bot().setOnGround(true);
    }

    private static void assertFailure(GameTestHelper helper, String terminal,
                                      BlockPos target, String expected) {
        JsonObject result = result(terminal);
        JsonObject data = result.getAsJsonObject("data");
        helper.assertTrue(!result.get("success").getAsBoolean()
                        && data.size() == 2
                        && expected.equals(data.get("failure_type").getAsString())
                        && samePosition(data.getAsJsonObject("position"), target),
                "break_block did not return exact " + expected + " data: " + terminal);
    }

    private static void assertOccludedByBlock(GameTestHelper helper, String terminal,
                                              BlockPos target, BlockPos blocker,
                                              String blockState) {
        JsonObject result = result(terminal);
        JsonObject data = result.getAsJsonObject("data");
        JsonObject occluding = data.getAsJsonObject("occluding_block");
        helper.assertTrue(!result.get("success").getAsBoolean()
                        && data.size() == 3
                        && "occluded".equals(data.get("failure_type").getAsString())
                        && samePosition(data.getAsJsonObject("position"), target)
                        && occluding != null
                        && samePosition(occluding.getAsJsonObject("position"), blocker)
                        && blockState.equals(occluding.get("block_state").getAsString()),
                "break_block did not return exact occluding block data: " + terminal);
    }

    private static boolean samePosition(JsonObject value, BlockPos expected) {
        return value.get("x").getAsInt() == expected.getX()
                && value.get("y").getAsInt() == expected.getY()
                && value.get("z").getAsInt() == expected.getZ();
    }

    private static JsonObject result(String terminal) {
        return JsonParser.parseString(terminal).getAsJsonObject();
    }

    private static void cleanup(Fixture fixture) {
        fixture.bot().closeContainer();
        fixture.bot().setGameMode(GameType.SURVIVAL);
        fixture.bot().getInventory().clearContent();
        fixture.bot().setDeltaMovement(Vec3.ZERO);
        fixture.bot().fallDistance = 0.0F;
        Vec3 spawn = Vec3.atBottomCenterOf(fixture.level().getSharedSpawnPos());
        fixture.bot().moveTo(spawn.x, spawn.y, spawn.z,
                fixture.bot().getYRot(), fixture.bot().getXRot());
    }

    private record Fixture(ServerLevel level, BotPlayer bot, BlockPos target,
                           DefaultRuntimeToolGateway tools) {}
}
