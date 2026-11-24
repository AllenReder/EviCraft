package dev.mcagent.runtime.evidence;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.phys.Vec3;

import java.util.Objects;
import java.util.UUID;

/** One exact entity snapshot admitted by vision or an attributable Actor action. */
public record EntityObservation(
        UUID uuid,
        String entityId,
        String itemId,
        Integer itemCount,
        Vec3 position,
        Float health,
        Float maxHealth,
        boolean hostile,
        EntityEvidenceSource source
) {
    public EntityObservation {
        Objects.requireNonNull(uuid, "uuid");
        Objects.requireNonNull(entityId, "entityId");
        Objects.requireNonNull(position, "position");
        Objects.requireNonNull(source, "source");
        if ((itemId == null) != (itemCount == null) || itemCount != null && itemCount < 1) {
            throw new IllegalArgumentException("item evidence requires a positive count");
        }
        if ((health == null) != (maxHealth == null)) {
            throw new IllegalArgumentException("living evidence requires health and max health");
        }
    }

    public static EntityObservation visible(
            UUID uuid, String entityId, String itemId, Integer itemCount,
            Vec3 position, Float health, Float maxHealth, boolean hostile) {
        return new EntityObservation(uuid, entityId, itemId, itemCount, position,
                health, maxHealth, hostile, EntityEvidenceSource.VISION);
    }

    public static EntityObservation attributable(
            UUID uuid, String entityId, String itemId, Integer itemCount,
            Vec3 position, Float health, Float maxHealth) {
        return new EntityObservation(uuid, entityId, itemId, itemCount, position,
                health, maxHealth, false, EntityEvidenceSource.ATTRIBUTABLE_ACTION);
    }

    public static EntityObservation loaded(
            UUID uuid, String entityId, String itemId, Integer itemCount,
            Vec3 position, Float health, Float maxHealth, boolean hostile) {
        return new EntityObservation(uuid, entityId, itemId, itemCount, position,
                health, maxHealth, hostile, EntityEvidenceSource.LOADED_WORLD_STATE);
    }

    /** Snapshot one currently admitted live entity with provider-specific provenance. */
    public static EntityObservation current(Entity entity, EntityEvidenceSource source) {
        Objects.requireNonNull(entity, "entity");
        Objects.requireNonNull(source, "source");
        if (source != EntityEvidenceSource.VISION
                && source != EntityEvidenceSource.LOADED_WORLD_STATE) {
            throw new IllegalArgumentException("current entity requires current provenance");
        }
        String entityId = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
        String itemId = null;
        Integer itemCount = null;
        if (entity instanceof ItemEntity item) {
            itemId = BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString();
            itemCount = item.getItem().getCount();
        }
        Float health = null;
        Float maxHealth = null;
        if (entity instanceof LivingEntity living) {
            health = living.getHealth();
            maxHealth = living.getMaxHealth();
        }
        return new EntityObservation(entity.getUUID(), entityId, itemId, itemCount,
                entity.position(), health, maxHealth, entity instanceof Enemy, source);
    }
}
