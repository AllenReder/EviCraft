package dev.mcagent.runtime.bot;

import dev.mcagent.runtime.core.RuntimeCore;
import dev.mcagent.runtime.agent.tool.ToolRegistry;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AutonomyDisabledTest {

    @Test
    void coreInitDoesNotRegisterAutonomousSurvivalChains() {
        RuntimeCore.init();

        assertNull(ToolRegistry.resolve("get_owner_status"));
        assertNull(ToolRegistry.resolve("load_skill"));
    }

    @Test
    void coreInitRegistersOnlyTheRuntimeBaselineTools() {
        RuntimeCore.init();

        assertEquals(List.of("get_self_status", "get_world_info", "manage_scaffold_materials", "goto", "goto_block_interaction_pose", "goto_block_placement_pose", "break_block", "use_item", "activate_block", "use_item_on_block", "place_block",
                        "enter_bed", "interact_entity", "collect_items", "attack", "inspect_gui", "menu_button", "close_gui",
                        "equip_item", "eat", "drop_items", "transfer", "lookup_registry", "lookup_recipe", "craft",
                        "throw_eye_of_ender"),
                ToolRegistry.all().stream().map(tool -> tool.name()).toList());
        var manageScaffolds = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("manage_scaffold_materials"))
                .findFirst().orElseThrow();
        @SuppressWarnings("unchecked")
        var scaffoldProperties = (java.util.Map<String, Object>)
                manageScaffolds.parameterSchema().get("properties");
        assertEquals(java.util.Set.of("action", "item_id_globs"), scaffoldProperties.keySet());
        @SuppressWarnings("unchecked")
        var scaffoldAction = (java.util.Map<String, Object>) scaffoldProperties.get("action");
        assertEquals(List.of("read", "add", "delete", "set", "clear"), scaffoldAction.get("enum"));
        @SuppressWarnings("unchecked")
        var scaffoldGlobs = (java.util.Map<String, Object>) scaffoldProperties.get("item_id_globs");
        assertEquals(16, scaffoldGlobs.get("maxItems"));
        assertNull(ToolRegistry.resolve("scaffold_materials"));
        var interactionPose = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("goto_block_interaction_pose"))
                .findFirst().orElseThrow();
        @SuppressWarnings("unchecked")
        var interactionPoseProperties = (java.util.Map<String, Object>)
                interactionPose.parameterSchema().get("properties");
        assertEquals(java.util.Set.of("position", "item_id"), interactionPoseProperties.keySet());
        assertEquals(List.of("position"), interactionPose.parameterSchema().get("required"));
        @SuppressWarnings("unchecked")
        var interactionPosePosition = (java.util.Map<String, Object>)
                interactionPoseProperties.get("position");
        assertEquals(java.util.List.of("x", "y", "z"),
                interactionPosePosition.get("required"));
        assertEquals(false, interactionPosePosition.get("additionalProperties"));
        var placementPose = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("goto_block_placement_pose"))
                .findFirst().orElseThrow();
        @SuppressWarnings("unchecked")
        var placementPoseProperties = (java.util.Map<String, Object>)
                placementPose.parameterSchema().get("properties");
        assertEquals(java.util.Set.of("item_id", "position"), placementPoseProperties.keySet());
        assertEquals(List.of("item_id", "position"),
                placementPose.parameterSchema().get("required"));
        var activateBlock = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("activate_block"))
                .findFirst().orElseThrow();
        @SuppressWarnings("unchecked")
        var activateProperties = (java.util.Map<String, Object>)
                activateBlock.parameterSchema().get("properties");
        assertEquals(java.util.Set.of("position"), activateProperties.keySet());
        @SuppressWarnings("unchecked")
        var positionSchema = (java.util.Map<String, Object>) activateProperties.get("position");
        assertEquals(java.util.List.of("x", "y", "z"), positionSchema.get("required"));
        assertEquals(false, positionSchema.get("additionalProperties"));
        JsonObject malformed = new JsonObject();
        JsonObject missingZ = new JsonObject();
        missingZ.addProperty("x", 1);
        missingZ.addProperty("y", 2);
        malformed.add("position", missingZ);
        assertThrows(IllegalArgumentException.class,
                () -> activateBlock.onServerCall("test", malformed, null, ignored -> {}));
        var useItemOnBlock = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("use_item_on_block"))
                .findFirst().orElseThrow();
        @SuppressWarnings("unchecked")
        var useProperties = (java.util.Map<String, Object>)
                useItemOnBlock.parameterSchema().get("properties");
        assertEquals(java.util.Set.of("item_id", "position"), useProperties.keySet());
        assertEquals(List.of("item_id", "position"),
                useItemOnBlock.parameterSchema().get("required"));
        var placeBlock = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("place_block"))
                .findFirst().orElseThrow();
        @SuppressWarnings("unchecked")
        var placeProperties = (java.util.Map<String, Object>)
                placeBlock.parameterSchema().get("properties");
        assertEquals(java.util.Set.of("item_id", "position"), placeProperties.keySet());
        assertEquals(List.of("item_id", "position"), placeBlock.parameterSchema().get("required"));
        var enterBed = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("enter_bed"))
                .findFirst().orElseThrow();
        @SuppressWarnings("unchecked")
        var enterBedProperties = (java.util.Map<String, Object>)
                enterBed.parameterSchema().get("properties");
        assertEquals(java.util.Set.of("position"), enterBedProperties.keySet());
        assertEquals(List.of("position"), enterBed.parameterSchema().get("required"));
        var interactEntity = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("interact_entity"))
                .findFirst().orElseThrow();
        var schema = interactEntity.parameterSchema();
        @SuppressWarnings("unchecked")
        var properties = (java.util.Map<String, Object>) schema.get("properties");
        assertEquals(java.util.Set.of("uuid", "hold_ticks", "item_id"),
                properties.keySet());
        assertEquals(List.of("uuid", "hold_ticks", "item_id"), schema.get("required"));
        var collectItems = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("collect_items"))
                .findFirst().orElseThrow();
        var collectSchema = collectItems.parameterSchema();
        @SuppressWarnings("unchecked")
        var collectProperties = (java.util.Map<String, Object>)
                collectSchema.get("properties");
        assertEquals(java.util.Set.of("uuids", "item_id_glob", "radius"),
                collectProperties.keySet());
        assertEquals(List.of("uuids", "radius"),
                collectSchema.get("required"));
        @SuppressWarnings("unchecked")
        var uuidSchema = (java.util.Map<String, Object>) collectProperties.get("uuids");
        assertEquals(1, uuidSchema.get("minItems"));
        assertEquals(64, uuidSchema.get("maxItems"));
        @SuppressWarnings("unchecked")
        var radiusSchema = (java.util.Map<String, Object>) collectProperties.get("radius");
        assertEquals(1, radiusSchema.get("minimum"));
        assertEquals(48, radiusSchema.get("maximum"));
        var attack = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("attack"))
                .findFirst().orElseThrow();
        var attackSchema = attack.parameterSchema();
        @SuppressWarnings("unchecked")
        var attackProperties = (java.util.Map<String, Object>) attackSchema.get("properties");
        assertEquals(java.util.Set.of("uuids"), attackProperties.keySet());
        assertEquals(List.of("uuids"), attackSchema.get("required"));
        @SuppressWarnings("unchecked")
        var attackUuids = (java.util.Map<String, Object>) attackProperties.get("uuids");
        assertEquals(List.of("array", "null"), attackUuids.get("type"));
        assertEquals(1, attackUuids.get("minItems"));
        assertEquals(20, attackUuids.get("maxItems"));
        var lookupRegistry = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("lookup_registry"))
                .findFirst().orElseThrow();
        @SuppressWarnings("unchecked")
        var registryProperties = (java.util.Map<String, Object>)
                lookupRegistry.parameterSchema().get("properties");
        @SuppressWarnings("unchecked")
        var registryKind = (java.util.Map<String, Object>) registryProperties.get("kind");
        assertEquals(List.of(
                        "item", "block", "entity", "biome", "structure",
                        "item_tag", "block_tag", "biome_tag", "structure_tag"),
                registryKind.get("enum"));
        assertTrue(lookupRegistry.description().contains("entity type"));
        var lookupRecipe = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("lookup_recipe"))
                .findFirst().orElseThrow();
        var lookupSchema = lookupRecipe.parameterSchema();
        @SuppressWarnings("unchecked")
        var lookupProperties = (java.util.Map<String, Object>) lookupSchema.get("properties");
        assertEquals(java.util.Set.of("recipe_or_output_id_glob"),
                lookupProperties.keySet());
        assertEquals(List.of(),
                lookupSchema.get("required"));
        var gotoTool = ToolRegistry.all().stream()
                .filter(tool -> tool.name().equals("goto"))
                .findFirst().orElseThrow();
        @SuppressWarnings("unchecked")
        var gotoProperties = (java.util.Map<String, Object>)
                gotoTool.parameterSchema().get("properties");
        assertEquals(java.util.Set.of("goal", "route_mutation_permissions"), gotoProperties.keySet());
        @SuppressWarnings("unchecked")
        var gotoPermissions = (java.util.Map<String, Object>)
                gotoProperties.get("route_mutation_permissions");
        @SuppressWarnings("unchecked")
        var gotoPermissionItems = (java.util.Map<String, Object>)
                gotoPermissions.get("items");
        assertEquals(List.of("OPEN", "BREAK", "PLACE"), gotoPermissionItems.get("enum"));
        assertEquals(3, gotoPermissions.get("maxItems"));
        assertEquals(true, gotoPermissions.get("uniqueItems"));
        @SuppressWarnings("unchecked")
        var gotoRequired = (List<String>) gotoTool.parameterSchema().get("required");
        assertFalse(gotoRequired.contains("route_mutation_permissions"));
        for (String forbidden : List.of(
                "locate_structure", "locate_biome", "get_owner_status",
                "task_status", "task_stop", "set_timer", "mine", "auto_mine", "take_items",
                "inspect_block_storage")) {
            assertNull(ToolRegistry.resolve(forbidden));
        }
    }
}
