package dev.mcagent.runtime.evidence;

import dev.mcagent.runtime.entity.BotPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;

import java.util.Comparator;
import java.util.List;

/** Entities in sight of the eye, by the same rays and occlusion rules as block sight. */
final class GroundedEntitySensor {

    private GroundedEntitySensor() {}

    /** Sample after {@code sight} has sampled the same Actor in the same tick. */
    static List<EntityObservation> sample(BotPlayer bot, GroundedBlockSensor sight) {
        return bot.serverLevel().getEntities(bot,
                        bot.getBoundingBox().inflate(GroundedBlockSensor.RANGE),
                        entity -> entity.isAlive()
                                && !entity.isSpectator()
                                && (!(entity instanceof ItemEntity item) || !item.getItem().isEmpty())
                                && !entity.isInvisibleTo(bot)
                                && sight.sees(entity.getBoundingBox(), entity.getEyePosition()))
                .stream()
                .sorted(Comparator.comparing((Entity entity) -> entity.getUUID().toString()))
                .map(entity -> EntityObservation.current(entity, EntityEvidenceSource.VISION))
                .toList();
    }
}
