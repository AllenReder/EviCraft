package dev.mcagent.runtime.core.tools.perception;

import dev.mcagent.runtime.agent.tool.Schema;
import dev.mcagent.runtime.agent.tool.RuntimeTool;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskResult;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import dev.mcagent.runtime.sdk.RuntimeBodyStateSnapshot;

import java.util.Map;
import java.util.List;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.function.Consumer;

/**
 * A query tool: runs on the body server-side and replies in place. No arguments
 * → an empty schema. The body of {@link #onServerCall} is just the perception
 * logic.
 */
public final class GetSelfStatusTool implements RuntimeTool {

    @Override
    public String name() {
        return "get_self_status";
    }

    @Override
    public String description() {
        return "Report the state of the Bot: name, game mode, health, hunger, position, "
                + "dimension, equipment, active effects and movement state. "
                + "raw_inventory lists the carried stacks by Inventory slot, with consumable flags and "
                + "potion variants. Inventory slot numbers are not menu slot indices.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Schema.none();
    }

    @Override
    public void onServerCall(String toolCallId, JsonObject args, BotPlayer self, Consumer<String> reply) {
        JsonObject root = new JsonObject();
        root.addProperty("entity_id", self.getId());
        root.addProperty("name", self.getName().getString());
        root.addProperty("game_mode", self.gameMode.getGameModeForPlayer().getName());
        root.addProperty("hp", self.getHealth());
        root.addProperty("max_hp", self.getMaxHealth());
        root.addProperty("hunger", self.getFoodData().getFoodLevel());

        JsonObject pos = new JsonObject();
        pos.addProperty("x", self.getX());
        pos.addProperty("y", self.getY());
        pos.addProperty("z", self.getZ());
        root.add("position", pos);

        root.addProperty("dimension", self.level().dimension().location().toString());

        JsonObject equipment = new JsonObject();
        for (EquipmentSlot slot : EquipmentSlot.values()) {
            ItemStack s = self.getItemBySlot(slot);
            if (s.isEmpty()) continue;
            JsonObject o = new JsonObject();
            o.addProperty("item", BuiltInRegistries.ITEM.getKey(s.getItem()).toString());
            if (s.getCount() > 1) o.addProperty("count", s.getCount());
            o.addProperty("damage", s.getDamageValue());
            o.addProperty("max_damage", s.getMaxDamage());
            var customName = s.get(DataComponents.CUSTOM_NAME);
            if (customName != null) o.addProperty("custom_name", customName.getString());
            equipment.add(slot.getName(), o);
        }
        root.add("equipment", equipment);

        // Inventory indices bind a current stack for native consumption; they are not GUI indices.
        var inv = self.getInventory();
        JsonObject slots = new JsonObject();
        JsonArray rawInventory = new JsonArray();
        root.addProperty("selected_hotbar_slot", inv.selected);
        int used = 0;
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack stack = inv.getItem(i);
            if (stack.isEmpty()) continue;
            used++;
            JsonObject entry = new JsonObject();
            entry.addProperty("slot", i);
            entry.addProperty("item", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
            entry.addProperty("count", stack.getCount());
            entry.addProperty("damage", stack.getDamageValue());
            entry.addProperty("max_damage", stack.getMaxDamage());
            entry.addProperty("consumable", stack.get(DataComponents.FOOD) != null
                    || stack.is(Items.MILK_BUCKET) || stack.is(Items.POTION));
            var contents = stack.get(DataComponents.POTION_CONTENTS);
            if (contents != null) {
                JsonObject potion = new JsonObject();
                potion.addProperty("potion_id", contents.potion()
                        .flatMap(value -> value.unwrapKey()).map(key -> key.location().toString()).orElse(null));
                JsonArray potionEffects = new JsonArray();
                for (var effect : contents.getAllEffects()) {
                    JsonObject observedEffect = new JsonObject();
                    observedEffect.addProperty("effect_id", BuiltInRegistries.MOB_EFFECT
                            .getKey(effect.getEffect().value()).toString());
                    observedEffect.addProperty("amplifier", effect.getAmplifier());
                    observedEffect.addProperty("duration_ticks", effect.getDuration());
                    potionEffects.add(observedEffect);
                }
                potion.add("effects", potionEffects);
                entry.add("potion", potion);
            }
            var customName = stack.get(DataComponents.CUSTOM_NAME);
            if (customName != null) entry.addProperty("custom_name", customName.getString());
            rawInventory.add(entry);
        }
        slots.addProperty("used", used);
        slots.addProperty("total", inv.getContainerSize());
        root.add("backpack_slots", slots);
        root.add("raw_inventory", rawInventory);

        root.add("target", JsonNull.INSTANCE);
        root.addProperty("on_ground", self.onGround());
        root.addProperty("in_water", self.isInWater());
        // Remaining breath: without it the model cannot tell the Bot is drowning and may keep
        // planning long trips underwater.
        root.addProperty("air", self.getAirSupply() + "/" + self.getMaxAirSupply() + " ticks");
        root.addProperty("in_lava", self.isInLava());
        root.addProperty("underwater", self.isUnderWater());
        root.addProperty("on_fire", self.isOnFire());
        RuntimeBodyStateSnapshot bodyState = RuntimeBodyStateSnapshot.capture(self);
        root.addProperty("suffocating", bodyState.suffocating());
        JsonArray intersectingBlocks = new JsonArray();
        for (RuntimeBodyStateSnapshot.BlockPosition position : bodyState.intersectingBlocks()) {
            JsonObject block = new JsonObject();
            block.addProperty("x", position.x());
            block.addProperty("y", position.y());
            block.addProperty("z", position.z());
            intersectingBlocks.add(block);
        }
        root.add("intersecting_blocks", intersectingBlocks);
        root.addProperty("fall_distance", self.fallDistance);
        root.addProperty("facing", self.getDirection().getName());

        JsonObject feet = new JsonObject();
        feet.addProperty("x", self.blockPosition().getX());
        feet.addProperty("y", self.blockPosition().getY());
        feet.addProperty("z", self.blockPosition().getZ());
        root.add("feet", feet);

        JsonObject velocity = new JsonObject();
        velocity.addProperty("x", self.getDeltaMovement().x);
        velocity.addProperty("y", self.getDeltaMovement().y);
        velocity.addProperty("z", self.getDeltaMovement().z);
        root.add("velocity", velocity);

        List<Map<String, Object>> effects = new ArrayList<>();
        for (var instance : self.getActiveEffects()) {
            Map<String, Object> effect = new LinkedHashMap<>();
            effect.put("effect_id", BuiltInRegistries.MOB_EFFECT
                    .getKey(instance.getEffect().value()).toString());
            effect.put("amplifier", instance.getAmplifier());
            effect.put("duration_ticks", instance.getDuration());
            effects.add(effect);
        }
        root.add("active_effects", new Gson().toJsonTree(effects));

        @SuppressWarnings("unchecked")
        Map<String, Object> data = new Gson().fromJson(root, Map.class);
        reply.accept(TaskResult.ok("current body status", data).toJson());
    }
}
