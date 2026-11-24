package dev.mcagent.runtime.core.gametest;

import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.gametest.framework.StructureUtils;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/** Focused physical enforcement suite for call-scoped Route Mutation Permission. */
@GameTestHolder("mc_agent_route_mutation")
@PrefixGameTestTemplate(false)
public final class RouteMutationPermissionGameTests {

    private RouteMutationPermissionGameTests() {}

    static {
        String dir = System.getProperty("mc_agent.gametest.structures");
        if (dir != null) StructureUtils.testStructuresDir = dir;
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 2400, batch = "route_mutation_empty_door")
    public static void empty_permission_cannot_open_a_closed_door(GameTestHelper helper) {
        dev.mcagent.runtime.gametest.RouteMutationPermissionGameTests
                .empty_permission_cannot_open_a_closed_door(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 2400, batch = "route_mutation_open_door")
    public static void open_only_permission_opens_a_closed_door(GameTestHelper helper) {
        dev.mcagent.runtime.gametest.RouteMutationPermissionGameTests
                .open_only_permission_opens_a_closed_door(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 2400, batch = "route_mutation_open_wall")
    public static void open_only_permission_cannot_break_a_required_wall(GameTestHelper helper) {
        dev.mcagent.runtime.gametest.RouteMutationPermissionGameTests
                .open_only_permission_cannot_break_a_required_wall(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 2400, batch = "route_mutation_break_wall")
    public static void break_permission_retains_verified_wall_traversal(GameTestHelper helper) {
        dev.mcagent.runtime.gametest.RouteMutationPermissionGameTests
                .break_permission_retains_verified_wall_traversal(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 2400, batch = "route_mutation_open_gap")
    public static void open_only_permission_cannot_bridge_a_required_gap(GameTestHelper helper) {
        dev.mcagent.runtime.gametest.RouteMutationPermissionGameTests
                .open_only_permission_cannot_bridge_a_required_gap(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 2400, batch = "route_mutation_place_gap")
    public static void place_permission_retains_verified_bridge_traversal(GameTestHelper helper) {
        dev.mcagent.runtime.gametest.RouteMutationPermissionGameTests
                .place_permission_retains_verified_bridge_traversal(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 900, batch = "route_pillar_feasible")
    public static void pillar_feasible_forms_real_support(GameTestHelper helper) {
        dev.mcagent.runtime.gametest.PillarFailureFeedbackGameTests
                .feasible_pillar_forms_real_support(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 900, batch = "route_pillar_infeasible")
    public static void pillar_infeasible_fails_explained(GameTestHelper helper) {
        dev.mcagent.runtime.gametest.PillarFailureFeedbackGameTests
                .infeasible_pillar_fails_explained_within_bounded_attempts(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 900, batch = "route_pillar_transient")
    public static void pillar_transient_blockage_recovers(GameTestHelper helper) {
        dev.mcagent.runtime.gametest.PillarFailureFeedbackGameTests
                .transient_blockage_recovers_after_clearing(helper);
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 300, batch = "pva_activate")
    public static void pva_activate_success_and_failure(GameTestHelper helper) {
        dev.mcagent.runtime.api.gametest.VerifiedBlockInteractionGameTests
                .activate_block_requires_state_change_and_rejects_changed_evidence(helper);
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 500, batch = "pva_break")
    public static void pva_break_success_and_failure(GameTestHelper helper) {
        dev.mcagent.runtime.api.gametest.VerifiedBreakBlockGameTests
                .break_block_verifies_exact_disappearance_and_changed_target(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 360, batch = "route_mutation_break_implement")
    public static void pva_break_selects_a_suitable_carried_implement(GameTestHelper helper) {
        dev.mcagent.runtime.api.gametest.VerifiedBreakBlockGameTests
                .break_block_selects_a_suitable_carried_implement(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 360, batch = "route_mutation_break_without_correct_implement")
    public static void pva_break_continues_without_a_correct_implement(GameTestHelper helper) {
        dev.mcagent.runtime.api.gametest.VerifiedBreakBlockGameTests
                .break_block_continues_without_a_correct_implement(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 240, batch = "route_mutation_break_validation_hand")
    public static void pva_rejected_break_does_not_select_an_implement(GameTestHelper helper) {
        dev.mcagent.runtime.api.gametest.VerifiedBreakBlockGameTests
                .rejected_break_does_not_select_an_implement(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 240, batch = "route_mutation_break_creative_hand")
    public static void pva_creative_break_does_not_select_an_implement(GameTestHelper helper) {
        dev.mcagent.runtime.api.gametest.VerifiedBreakBlockGameTests
                .creative_break_does_not_select_an_implement(helper);
    }

    @GameTest(templateNamespace = "mc_agent_route_mutation", template = "empty_36x10x20",
            timeoutTicks = 240, batch = "route_mutation_break_interruption")
    public static void pva_break_interruption_retains_selected_implement(GameTestHelper helper) {
        dev.mcagent.runtime.api.gametest.VerifiedBreakBlockGameTests
                .break_block_interruption_keeps_only_verified_position(helper);
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 420, batch = "pva_item")
    public static void pva_item_use_success_and_failure(GameTestHelper helper) {
        dev.mcagent.runtime.api.gametest.VerifiedItemOnBlockGameTests
                .failures_are_typed_isolated_and_restored(helper);
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 300, batch = "pva_item_success")
    public static void pva_item_use_legal_success(GameTestHelper helper) {
        dev.mcagent.runtime.api.gametest.VerifiedItemOnBlockGameTests
                .flint_and_eye_report_exact_effects_and_restore_inventory(helper);
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 480, batch = "pva_place")
    public static void pva_placement_success_and_failure(GameTestHelper helper) {
        dev.mcagent.runtime.api.gametest.VerifiedPlacementGameTests
                .placement_failures_are_typed_and_do_not_dispatch(helper);
    }

    @GameTest(templateNamespace = "minecraft", template = "bastion/mobs/empty",
            timeoutTicks = 240, batch = "pva_interface")
    public static void pva_interface_returns_success_and_failure(GameTestHelper helper) {
        var level = helper.getLevel();
        dev.mcagent.runtime.bot.RuntimeBotManager.stop(level.getServer());
        dev.mcagent.runtime.bot.RuntimeBotManager.create(level.getServer(), "bot");
        var bot = dev.mcagent.runtime.bot.RuntimeBotManager.current(level.getServer())
                .orElseThrow();
        var feet = helper.absolutePos(new net.minecraft.core.BlockPos(4, 4, 4));
        var target = feet.east(2).above();
        level.setBlockAndUpdate(feet.below(), net.minecraft.world.level.block.Blocks.STONE
                .defaultBlockState());
        level.setBlockAndUpdate(target, net.minecraft.world.level.block.Blocks.LEVER
                .defaultBlockState());
        bot.moveTo(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5, -90.0F, 0.0F);
        dev.mcagent.runtime.bot.RuntimeBotManager.tick(level.getServer());
        dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.publishBlock(level.getServer(),
                level.dimension().location().toString(), level.getGameTime(), target,
                level.getBlockState(target),
                dev.mcagent.runtime.evidence.BlockEvidenceSource.MISMATCH);
        var evidence = dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(level.getServer(),
                level.dimension().location().toString(), target);
        var action = new dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority.Activate(
                new dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority.BoundBlock(
                        target, evidence));
        helper.assertTrue(dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority
                        .probe(bot, action) instanceof
                        dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority.Ready,
                "PVA probe did not return Ready for a reachable exact lever");
        var operation = dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority
                .begin(bot, action);
        java.util.concurrent.atomic.AtomicReference<
                dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority.Step> step =
                new java.util.concurrent.atomic.AtomicReference<>();
        helper.startSequence()
                .thenWaitUntil(() -> {
                    var current = operation.tick();
                    step.set(current);
                    helper.assertTrue(!(current instanceof
                                    dev.mcagent.runtime.core.task.interact
                                            .PhysicalVerificationAuthority.Running),
                            "PVA activation is still running");
                })
                .thenExecute(() -> {
                    helper.assertTrue(step.get() instanceof
                                    dev.mcagent.runtime.core.task.interact
                                            .PhysicalVerificationAuthority.Succeeded,
                            "PVA Interface did not return Succeeded");
                    level.setBlockAndUpdate(target,
                            net.minecraft.world.level.block.Blocks.STONE.defaultBlockState());
                    dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.publishBlock(
                            level.getServer(), level.dimension().location().toString(),
                            level.getGameTime(), target, level.getBlockState(target),
                            dev.mcagent.runtime.evidence.BlockEvidenceSource.MISMATCH);
                    var stone = dev.mcagent.runtime.api.gametest.RuntimeKnowledgeFixtures.block(
                            level.getServer(), level.dimension().location().toString(), target);
                    level.setBlockAndUpdate(target,
                            net.minecraft.world.level.block.Blocks.DIRT.defaultBlockState());
                    var changed = new dev.mcagent.runtime.core.task.interact
                            .PhysicalVerificationAuthority.Activate(
                            new dev.mcagent.runtime.core.task.interact
                                    .PhysicalVerificationAuthority.BoundBlock(target, stone));
                    var failed = dev.mcagent.runtime.core.task.interact
                            .PhysicalVerificationAuthority.begin(bot, changed).tick();
                    helper.assertTrue(failed instanceof dev.mcagent.runtime.core.task.interact
                                    .PhysicalVerificationAuthority.Failed failure
                                    && failure.failure().code() == dev.mcagent.runtime.core.task.interact
                                    .PhysicalVerificationAuthority.FailureCode.TARGET_CHANGED,
                            "PVA Interface did not return TARGET_CHANGED");
                    helper.assertTrue(level.getBlockState(target).is(
                                    net.minecraft.world.level.block.Blocks.DIRT),
                            "failed identity verification changed the target world state");
                })
                .thenSucceed();
    }
}
