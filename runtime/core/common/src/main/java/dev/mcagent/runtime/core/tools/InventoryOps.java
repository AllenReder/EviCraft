package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.agent.tool.ToolArgs;
import dev.mcagent.runtime.agent.tool.api.ToolContext;
import dev.mcagent.runtime.task.TaskRecord;
import dev.mcagent.runtime.core.task.collect.CollectItemsTaskRecord;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierMatcher;
import dev.mcagent.runtime.core.task.inventory.DropItemsTaskRecord;
import dev.mcagent.runtime.core.task.inventory.EatItemTaskRecord;
import dev.mcagent.runtime.core.task.inventory.EquipTaskRecord;
import dev.mcagent.runtime.core.task.inventory.ThrowEyeOfEnderTaskRecord;
import dev.mcagent.runtime.core.task.inventory.UnequipTaskRecord;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.item.Item;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Inventory-management tool implementations — the business half of
 * {@code EquipItemTool} / {@code EatItemTool} / {@code DropItemsTool} /
 * {@code CollectItemsTool}. Each returns a {@link TaskRecord} the body's task
 * queue runs; the {@link ToolContext} carries the call id and deadline basis.
 */
public final class InventoryOps {

    private static final long EQUIP_TIMEOUT_TICKS = 5 * 20;   // instant; generous floor

    /** Generous — covers any food's eat duration (most ~1.6s) plus buffer. */
    private static final long EAT_TIMEOUT_TICKS = 15 * 20;

    private static final int DROP_MAX_COUNT = 999;
    private static final long DROP_TIMEOUT_TICKS = 10 * 20;

    private static final int COLLECT_DEFAULT_RADIUS = 8;
    private static final int COLLECT_MAX_RADIUS = 48;
    private static final long COLLECT_TIMEOUT_TICKS = 60 * 20;   // 1 min

    /** Native Eye flight ends after about 80 ticks; leave room for dispatch and cleanup. */
    private static final long THROW_EYE_TIMEOUT_TICKS = 120;

    public TaskRecord equipItem(
String action,
String item_id,
String slot,
            ToolContext ctx) {
        if ("unequip".equalsIgnoreCase(action)) {
            return new UnequipTaskRecord(ctx.toolCallId(), ctx.deadline(EQUIP_TIMEOUT_TICKS),
                    readUnequipSlots(slot), slot.toLowerCase());
        }
        if (item_id == null || item_id.isBlank()) {
            throw new IllegalArgumentException(
                    "item_id is required to equip (to take gear off, use action=unequip with a slot)");
        }
        EquipmentSlot equipSlot = readSlot(slot);

        Item item = ToolArgs.parseItem(item_id);
        String label = BuiltInRegistries.ITEM.getKey(item).getPath();
        return new EquipTaskRecord(ctx.toolCallId(), ctx.deadline(EQUIP_TIMEOUT_TICKS), item, equipSlot, label);
    }

    /** Parse the optional slot; {@code null} means auto-route. */
    private static EquipmentSlot readSlot(String slot) {
        if (slot == null) {
            return null;
        }
        String name = slot.toLowerCase();
        return switch (name) {
            case "mainhand", "hand" -> EquipmentSlot.MAINHAND;
            case "offhand" -> EquipmentSlot.OFFHAND;
            case "head" -> EquipmentSlot.HEAD;
            case "chest" -> EquipmentSlot.CHEST;
            case "legs" -> EquipmentSlot.LEGS;
            case "armor" -> throw new IllegalArgumentException(
                    "slot=armor is only for action=unequip (it means all four armor pieces)");
            case "feet" -> EquipmentSlot.FEET;
            default -> throw new IllegalArgumentException("unknown slot: " + name);
        };
    }

    /** Slots to unequip: required; {@code armor} expands to the four armor pieces. */
    private static List<EquipmentSlot> readUnequipSlots(String slot) {
        if (slot == null || slot.isBlank()) {
            throw new IllegalArgumentException(
                    "slot is required for unequip ('armor' takes all four armor pieces off)");
        }
        if ("armor".equalsIgnoreCase(slot)) {
            return List.of(EquipmentSlot.HEAD, EquipmentSlot.CHEST,
                    EquipmentSlot.LEGS, EquipmentSlot.FEET);
        }
        return List.of(readSlot(slot));
    }

    public TaskRecord eatItem(
String item_id,
Integer slot,
            ToolContext ctx) {
        if ((item_id == null) == (slot == null)) {
            throw new IllegalArgumentException("provide exactly one of item_id or slot");
        }
        if (slot != null && (slot < 0 || slot > 40)) {
            throw new IllegalArgumentException("slot must be an Inventory index from 0 to 40");
        }
        Item item = item_id == null ? null : ToolArgs.parseItem(item_id);
        String label = item == null ? "Inventory slot " + slot : BuiltInRegistries.ITEM.getKey(item).toString();
        return new EatItemTaskRecord(ctx.toolCallId(), ctx.deadline(EAT_TIMEOUT_TICKS), item, slot, label);
    }

    public TaskRecord dropItems(
String item_id,
int count,
            ToolContext ctx) {
        Item item = ToolArgs.parseItem(item_id);
        count = Math.clamp(count, 1, DROP_MAX_COUNT);
        String label = BuiltInRegistries.ITEM.getKey(item).getPath();
        return new DropItemsTaskRecord(ctx.toolCallId(), ctx.deadline(DROP_TIMEOUT_TICKS),
                item, count, label);
    }

    public TaskRecord collectItems(
List<String> uuids,
String itemIdGlob,
Integer radius,
            ToolContext ctx) {
        boolean uuidMode = uuids != null;
        boolean globMode = itemIdGlob != null;
        if ((uuidMode ? 1 : 0) + (globMode ? 1 : 0) != 1) {
            throw new IllegalArgumentException(
                    "provide exactly one of uuids or item_id_glob");
        }

        Set<UUID> exactTargets = new LinkedHashSet<>();
        if (uuidMode) {
            if (uuids.isEmpty() || uuids.size() > 64) {
                throw new IllegalArgumentException("uuids must contain 1 to 64 exact UUIDs");
            }
            for (String value : uuids) {
                if (value == null) {
                    throw new IllegalArgumentException(
                            "uuids must contain only exact Entity Track UUIDs");
                }
                UUID uuid;
                try {
                    uuid = UUID.fromString(value);
                } catch (IllegalArgumentException exception) {
                    throw new IllegalArgumentException(
                            "uuids must contain only exact Entity Track UUIDs");
                }
                if (!exactTargets.add(uuid)) {
                    throw new IllegalArgumentException("uuids must not contain duplicates");
                }
            }
        }
        CanonicalIdentifierMatcher itemMatcher = globMode
                ? CanonicalIdentifierGlob.compile(itemIdGlob) : null;

        int searchRadius = radius == null ? COLLECT_DEFAULT_RADIUS : radius;
        if (searchRadius < 1 || searchRadius > COLLECT_MAX_RADIUS) {
            throw new IllegalArgumentException("radius must be between 1 and 48");
        }

        return new CollectItemsTaskRecord(ctx.toolCallId(), ctx.deadline(COLLECT_TIMEOUT_TICKS),
                exactTargets, itemMatcher, itemIdGlob, uuidMode ? "uuids" : "item_id_glob",
                searchRadius);
    }

    public TaskRecord throwEyeOfEnder(ToolContext ctx) {
        return new ThrowEyeOfEnderTaskRecord(
                ctx.toolCallId(), ctx.deadline(THROW_EYE_TIMEOUT_TICKS));
    }

}
