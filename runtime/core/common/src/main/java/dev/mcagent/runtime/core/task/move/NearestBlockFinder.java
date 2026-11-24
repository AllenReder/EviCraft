package dev.mcagent.runtime.core.task.move;
import dev.mcagent.runtime.core.pathing.goal.GoalCompiler;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import net.minecraft.core.BlockPos;

import java.util.ArrayList;
import java.util.List;

/**
 * The FIND (nearest block) subsystem of goto: registers candidates, compiles an anyOf navigation contract,
 * and rotates by removing unreachable candidates one at a time. It shares no logic with goto's three
 * coordinate modes (BLOCK/COLUMN/YLEVEL); the task only drives it.
 *
 * <p>Candidates come only from the Block Knowledge selected for the Runtime Bot. An empty result means
 * unknown/not-known, not proof that the target does not exist in the world.
 */
final class NearestBlockFinder {

    /** Candidate cap and travel budget baseline. */
    private static final int MAX_CANDIDATES = 64;
    static final int BUDGET_BLOCKS = 128;

    private final BotPlayer player;
    private final String query;
    /** Candidate cells still registered (unreachable ones are removed one at a time). */
    private final List<BlockPos> candidates = new ArrayList<>();
    private boolean scanDrained;
    /** Navigation contract compiled from the candidate set (rebuilt when candidates change). */
    private GoalCompiler.Compiled contract;

    private NearestBlockFinder(BotPlayer player, String query) {
        this.player = player;
        this.query = query;
    }

    static NearestBlockFinder create(BotPlayer player, String query) {
        matcher(query);
        return new NearestBlockFinder(player, query);
    }

    /** Registers the {@link #MAX_CANDIDATES} matching blocks in knowledge nearest to the body. */
    void kickScan() {
        String dimension = RuntimeBotManager.currentDimension(player.getServer());
        RuntimeBotManager.knowledge(player.getServer()).blocks()
                .find(dimension, matcher(query), player.blockPosition(), MAX_CANDIDATES)
                .matches().forEach(match -> candidates.add(match.position()));
        scanDrained = true;
        rebuildContract();
    }

    private static CanonicalIdentifierGlob matcher(String query) {
        return CanonicalIdentifierGlob.compile(query);
    }

    String notFoundMessage() {
        return "unknown/not-known: no known block id full-matches '" + query
                + "'; observe or explore before selecting that target";
    }

    boolean hasCandidates() {
        return !candidates.isEmpty();
    }

    /** The search has been drained and no candidates remain. */
    boolean exhausted() {
        return scanDrained;
    }

    /** Navigation contract for the current candidates; null when there are none. */
    GoalCompiler.Compiled contract() {
        return contract;
    }

    private void rebuildContract() {
        contract = candidates.isEmpty() ? null : GoalCompiler.anyOf(candidates);
    }

    /** Rotation on an unreachable path: if others remain, remove the nearest candidate and rebuild the contract; keep the last one. */
    boolean rotateAfterFailure() {
        if (candidates.size() <= 1) {
            return false;
        }
        int nearest = nearestIndex();
        if (nearest >= 0) {
            candidates.remove(nearest);
        }
        rebuildContract();
        return true;
    }

    /** The registered candidate nearest to the body; null when there are none. */
    BlockPos nearest() {
        int i = nearestIndex();
        return i < 0 ? null : candidates.get(i);
    }

    private int nearestIndex() {
        int best = -1;
        double bestD = Double.MAX_VALUE;
        for (int i = 0; i < candidates.size(); i++) {
            BlockPos c = candidates.get(i);
            double d = player.distanceToSqr(c.getX() + 0.5, c.getY() + 0.5, c.getZ() + 0.5);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        return best;
    }
}
