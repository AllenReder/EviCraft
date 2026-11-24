package dev.mcagent.runtime.core.gametest;

import dev.mcagent.runtime.api.gametest.VerifiedPlacementGameTests;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.gametest.framework.StructureUtils;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/** Focused public-Tool regression suite for the exact placement-context module. */
@GameTestHolder("mc_agent_placement_context")
@PrefixGameTestTemplate(false)
public final class PlacementContextGameTests {
    private PlacementContextGameTests() {}

    static {
        String dir = System.getProperty("mc_agent.gametest.structures");
        if (dir != null) {
            StructureUtils.testStructuresDir = dir;
        }
    }

    @GameTest(templateNamespace = "mc_agent_placement_context", template = "empty_36x10x20",
            timeoutTicks = 320, batch = "placement_effects")
    public static void exact_placement_effects(GameTestHelper helper) {
        VerifiedPlacementGameTests.floor_side_and_creative_placements_are_exact(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_context", template = "empty_36x10x20",
            timeoutTicks = 240, batch = "placement_visible_outline")
    public static void visible_outline_context(GameTestHelper helper) {
        VerifiedPlacementGameTests
                .required_support_face_uses_visible_outline_when_center_is_occluded(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_context", template = "empty_36x10x20",
            timeoutTicks = 240, batch = "placement_entity_first_hit")
    public static void entity_first_hit_context(GameTestHelper helper) {
        VerifiedPlacementGameTests.entity_first_hit_blocks_center_and_outline_placement(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_context", template = "empty_36x10x20",
            timeoutTicks = 420, batch = "placement_failures")
    public static void typed_no_dispatch_failures(GameTestHelper helper) {
        VerifiedPlacementGameTests.placement_failures_are_typed_and_do_not_dispatch(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_context", template = "empty_36x10x20",
            timeoutTicks = 900, batch = "placement_cleanup")
    public static void cancellation_and_timeout_restore_body(GameTestHelper helper) {
        VerifiedPlacementGameTests.partial_cancellation_and_timeout_restore_layout(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_context", template = "empty_36x10x20",
            timeoutTicks = 420, batch = "placement_replaceable_targets")
    public static void replaceable_targets_and_explained_target_failures(GameTestHelper helper) {
        VerifiedPlacementGameTests
                .replaceable_targets_fill_in_place_and_target_failures_are_explained(helper);
    }

    @GameTest(templateNamespace = "mc_agent_placement_context", template = "empty_36x10x20",
            timeoutTicks = 420, batch = "placement_occupancy_classification")
    public static void occupancy_classification(GameTestHelper helper) {
        VerifiedPlacementGameTests
                .occupancy_classification_distinguishes_self_other_unknown(helper);
    }
}
