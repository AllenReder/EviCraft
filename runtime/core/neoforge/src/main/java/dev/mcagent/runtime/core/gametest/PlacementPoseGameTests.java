package dev.mcagent.runtime.core.gametest;

import dev.mcagent.runtime.api.gametest.VerifiedPlacementPoseGameTests;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.gametest.framework.StructureUtils;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/** Focused public-Tool regression suite for Placement-Reachable Poses. */
@GameTestHolder("mc_agent_placement_pose")
@PrefixGameTestTemplate(false)
public final class PlacementPoseGameTests {
    private PlacementPoseGameTests() {}

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 240, batch = "placement_pose_handoff")
    public static void placement_after_residual_drift(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests.placement_after_pose_waits_for_residual_drift(helper);
    }

    static {
        String dir = System.getProperty("mc_agent.gametest.structures");
        if (dir != null) StructureUtils.testStructuresDir = dir;
    }

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 320, batch = "placement_pose_immediate")
    public static void immediate_without_dispatch(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests
                .immediate_pose_is_verified_without_placement_or_consumption(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 1200, batch = "placement_pose_navigation")
    public static void frozen_navigation_and_protection(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests
                .navigation_reaches_a_frozen_pose_and_preserves_target_and_support(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 480, batch = "placement_pose_failures")
    public static void known_failures_and_observed_support_removal(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests
                .known_preconditions_and_observed_support_removal_are_stable(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 900, batch = "placement_pose_cleanup")
    public static void collision_interruption_timeout_and_restoration(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests
                .collision_occlusion_interruption_and_timeout_restore_body(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 360, batch = "placement_pose_multiple_supports")
    public static void multiple_known_supports(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests
                .multiple_known_supports_choose_the_visible_context(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 360, batch = "placement_pose_outline")
    public static void difficult_support_outline(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests
                .difficult_support_outline_is_verified_without_placement(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 1200, batch = "placement_pose_ray_blocker")
    public static void ray_blocker_protection(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests
                .ray_blocker_is_protected_while_navigation_uses_another_pose(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 1200, batch = "placement_pose_protected_route")
    public static void protected_target_and_support_route(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests
                .destructive_route_preserves_target_and_every_known_support(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 1200, batch = "placement_pose_exhausted")
    public static void exhausted_frozen_poses(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests
                .frozen_pose_candidates_exhaust_without_mutating_the_context(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 1200, batch = "placement_pose_target_change")
    public static void target_change_during_navigation(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests
                .target_change_during_navigation_is_rejected_before_placement(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 1600, batch = "placement_pose_promoted_ray_blocker")
    public static void promoted_non_neighbor_ray_blocker(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests
                .discovered_non_neighbor_ray_blocker_is_promoted_before_replan(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_pose", template = "empty_36x10x20",
            timeoutTicks = 1600, batch = "placement_pose_scaffold_protection")
    public static void scaffold_target_and_support_protection(GameTestHelper helper) {
        VerifiedPlacementPoseGameTests
                .scaffold_navigation_never_buries_target_or_known_support(helper);
    }
}
