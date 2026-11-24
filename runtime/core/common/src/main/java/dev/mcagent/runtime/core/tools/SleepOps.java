package dev.mcagent.runtime.core.tools;

import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority;
import dev.mcagent.runtime.task.TaskResult;
import com.mojang.datafixers.util.Either;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.BlockEvidenceCell;
import dev.mcagent.runtime.evidence.BlockEvidenceSource;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.util.Unit;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The logic half of {@code sleep}: <b>get into bed, then verify the Bot is actually asleep</b>.
 *
 * <h2>Why it is so thin</h2>
 * Finding a bed belongs to {@code scan_blocks} (which accepts {@code #minecraft:beds}, covering every color
 * at once), and walking there belongs to {@code goto}. Each already has a single implementation; wrapping
 * them here would add a third entry point. This class does only what nothing else can: <b>translate
 * vanilla's sleep verdict into a result the model can act on</b>.
 *
 * <h2>Three states, not two</h2>
 * {@code startSleepInBed} returns {@code Either<Problem, Unit>}, and {@code right} only means "not
 * rejected"; it does not mean "asleep". The real criterion is {@code isSleeping()}. So the middle state must
 * exist: <b>the request was accepted, but the Bot did not enter the sleeping state</b>. Without it, a
 * successful right-click would be taken as sleeping.
 *
 * <p>Rejection wording comes straight from vanilla ({@code BedSleepingProblem.message()}): daytime, bed
 * occupied, monsters nearby, too far away. None of it is invented here, and it follows the language files.
 */
public final class SleepOps {

    /** Vanilla's box for "is the bed within reach" (the one {@code Player.startSleepInBed} uses). */
    private static final int REACH_H = 3;
    private static final int REACH_V = 2;

    /** Exact, evidence-bound bed entry for the public Runtime Tool. */
    public String enterBed(BlockPos requested, BotPlayer self) {
        String dimension = self.level().dimension().location().toString();
        BlockEvidenceCell evidence = RuntimeBotManager.knowledge(self.getServer())
                .blocks().cell(dimension, requested);
        if (!evidenceNamesBed(evidence)) {
            return failure(requested, "target_changed",
                    "the exact target is not known bed evidence");
        }

        try (var operation = PhysicalVerificationAuthority.begin(self,
                new PhysicalVerificationAuthority.Sleep(
                        new PhysicalVerificationAuthority.BoundBlock(requested, evidence)))) {
            return switch (operation.tick()) {
                case PhysicalVerificationAuthority.Running ignored -> failure(requested,
                        "accepted_but_not_sleeping", "bed entry did not settle in one server tick");
                case PhysicalVerificationAuthority.Failed failed -> failure(requested,
                        failed.failure().code().wireValue(), failed.failure().message());
                case PhysicalVerificationAuthority.Succeeded succeeded -> {
                    BlockPos bedHead = ((PhysicalVerificationAuthority.SleepOutcome)
                            succeeded.outcome()).bedHead();
                    yield TaskResult.ok(
                            "sleeping verified; vanilla sleeping inherently updated the respawn point and this Tool does not wait for morning",
                            Map.of("position", position(bedHead), "sleeping", true)).toJson();
                }
            };
        }
    }

    /**
     * Rejection reasons <b>use vanilla's own words</b>, which are specific enough ("there are monsters nearby",
     * "the bed is too far away", "you can only sleep at night and during thunderstorms"). Rewriting them would
     * only produce hard-coded text that must track vanilla wording. They also follow the language files, so
     * a human can read them too.
     *
     * <p>{@code NOT_POSSIBLE_HERE} and {@code OTHER_PROBLEM} have no vanilla message ({@code getMessage()} is
     * {@code null}; vanilla handles those two elsewhere), so the enum name is all the information there is.
     * A null must not crash: that would turn "the Bot cannot sleep" into "the tool errored", which the model
     * cannot act on.
     */
    static String explain(Player.BedSleepingProblem problem) {
        return PhysicalVerificationAuthority.bedFailureMessage(problem);
    }

    static String failureType(Player.BedSleepingProblem problem, boolean sleeping) {
        return PhysicalVerificationAuthority.bedFailureType(problem, sleeping);
    }

    private static boolean evidenceNamesBed(BlockEvidenceCell evidence) {
        if (evidence.state() != BlockEvidenceCell.State.KNOWN_BLOCK) return false;
        String canonical = evidence.blockState();
        int properties = canonical.indexOf('[');
        String id = properties < 0 ? canonical : canonical.substring(0, properties);
        ResourceLocation location = ResourceLocation.tryParse(id);
        return location != null && BuiltInRegistries.BLOCK.get(location) instanceof BedBlock;
    }

    private static String failure(BlockPos position, String type, String message) {
        return TaskResult.fail(message, Map.of(
                "position", position(position),
                "failure_type", type)).toJson();
    }

    private static Map<String, Integer> position(BlockPos position) {
        return Map.of("x", position.getX(), "y", position.getY(), "z", position.getZ());
    }

}
