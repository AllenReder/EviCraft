package dev.mcagent.runtime.core.pathing.settings;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;

/**
 * Central definition of every ground-pathing knob: cost model, capability switches, search budgets,
 * segmentation, and execution parameters. All fields are public and mutable; writes take effect at runtime.
 * Global singleton via {@link #get()}.
 *
 * <p>Block/item list fields are exposed through lazy getters (the registry is touched only on first access),
 * so pure-logic unit tests can use the numeric fields without bootstrapping the Minecraft registries.
 */
public final class NavSettings {

    private static final NavSettings INSTANCE = new NavSettings();

    public static NavSettings get() {
        return INSTANCE;
    }

    private NavSettings() {}

    // ==================== Costs / capability switches ====================

    /**
     * Debug: enables the pathing profiler; {@link dev.mcagent.runtime.core.pathing.util.NavProfiler} logs
     * [nav-profile] per window. Off by default.
     */
    public boolean profile = false;

    /** Allow breaking blocks to clear a path. */
    public boolean allowBreak = true;
    /** Allow sprinting. */
    public boolean allowSprint = true;
    /** Allow placing blocks to build a path. */
    public boolean allowPlace = true;
    /** Allow items from the main inventory (slots 9-35): planning counts the whole inventory as consumables,
     *  and execution moves consumables/water buckets into the hotbar. When off, only hotbar and offhand
     * count. */
    public boolean allowInventory = true;
    /** Allow placing blocks into fluid source cells. */
    public boolean allowPlaceInFluidsSource = true;
    /** Allow placing blocks into flowing fluid cells. */
    public boolean allowPlaceInFluidsFlow = true;
    /** Cost penalty per placed block (saves blocks, discourages needless placement). */
    public double blockPlacementPenalty = 20.0;
    /**
     * Fixed extra cost per block break, on top of the pure break time.
     *
     * <p>30 is about 6.5 extra blocks of walking. The Bot lives in a world shared with others: breaking is a
     * last resort, not a shortcut. Going through a wall breaks two blocks (feet and head), about 17 blocks of
     * walking, so a door within a dozen or so blocks is preferred; underground with no way around, it still
     * digs. For reference, a mining-oriented bot uses about 2 (with good tools a wall is nearly free), and a
     * settled NPC cannot break at all (infinite). The Bot does both kinds of work, so this sits in between.
     */
    public double blockBreakAdditionalPenalty = 30.0;
    /** Extra penalty per jump. */
    public double jumpPenalty = 2.0;
    /** Extra penalty per block walked on water. */
    public double walkOnWaterOnePenalty = 3.0;
    /** Allow a water-bucket landing for long falls. */
    public boolean allowWaterBucketFall = true;
    /** Treat water surfaces as walkable ground (off by default; water uses swim-position semantics). */
    public boolean assumeWalkOnWater = false;
    /** Treat lava surfaces as walkable ground (off by default). */
    public boolean assumeWalkOnLava = false;
    /** Assume auto step-up (climbing one block needs no jump). */
    public boolean assumeStep = false;
    /** Assume safe walking (no sneaking while bridging). */
    public boolean assumeSafeWalk = false;
    /** Allow jumping at the build height limit. */
    public boolean allowJumpAtBuildLimit = false;
    /** Allow parkour jumps onto a landing one block higher. */
    public boolean allowParkourAscend = true;
    /** Allow diagonal descent. */
    public boolean allowDiagonalDescend = false;
    /** Allow diagonal ascent. */
    public boolean allowDiagonalAscend = false;
    /** Allow digging straight down. */
    public boolean allowDownward = true;
    /** Treat vines as climbable (off by default). */
    public boolean allowVines = false;
    /** Allow standing on bottom slabs. */
    public boolean allowWalkOnBottomSlab = true;
    /** Allow parkour jumps (2-4 block flat jumps, on by default). */
    public boolean allowParkour = true;
    /** Allow placing a block under the landing during a parkour jump (off by default). */
    public boolean allowParkourPlace = false;
    /** Include Haste/Mining Fatigue effects in break costs. */
    public boolean considerPotionEffects = true;
    /**
     * Strict liquid-neighbor check: forbid breaking next to any liquid (off by default; only sources and side
     * flow are forbidden).
     */
    public boolean strictLiquidCheck = false;
    /** Do not break blocks that would release falling blocks (sand/gravel neighbors). */
    public boolean avoidUpdatingFallingBlocks = true;
    /** Maximum acceptable fall height without water. */
    public int maxFallHeightNoWater = 3;
    /** Cost per point of fall damage, in tick equivalents. One block of walking is about 4.6, so the default
     *  of 20 trades each half heart for a detour of over four blocks: damage is not free, but survivable
     *  drops remain usable. */
    public double fallDamageCostPerPoint = 20.0;
    /** Maximum acceptable fall height when holding a water bucket. */
    public int maxFallHeightBucket = 20;
    /** Allow swords in mining tool selection. */
    public boolean useSwordToMine = true;
    /** Protect low-durability tools: tools below the threshold are excluded from selection. */
    public boolean itemSaver = false;
    /** Durability threshold for {@link #itemSaver}. */
    public int itemSaverThreshold = 10;
    /** Automatically switch to the best tool. */
    public boolean autoTool = true;
    /** Cost multiplier for temporarily placing a wrong block in a build target cell. */
    public double placeIncorrectBlockPenaltyMultiplier = 2.0;
    /** Whether building treats any existing non-air block as acceptable. */
    public boolean buildIgnoreExisting = false;
    /** Whether building ignores orientation block properties. */
    public boolean buildIgnoreDirection = false;
    /** Whether building treats water/liquid blocks as acceptable. */
    public boolean okIfWater = false;
    /** When clearing for a build, allow handling a block from near the layer above it. */
    public boolean breakFromAbove = false;
    /** When a clearing target can be handled from above, include the cells above it in the navigation goal. */
    public boolean goalBreakFromAbove = false;
    /** In layered building, whether to skip to the next layer when the current one has no actionable step. */
    public boolean skipFailedLayers = false;
    /** Break-speed multiplier for protected blocks (0.1 means cost x10). */
    public double avoidBreakingMultiplier = 0.1;
    /** Enable mob/spawner avoidance (off by default; when off, Favoring adds no avoidance spheres). */
    public boolean avoidance = false;
    /** Spawner avoidance coefficient (>1 avoids, <1 attracts). */
    public double mobSpawnerAvoidanceCoefficient = 2.0;
    /** Spawner avoidance radius, in blocks. */
    public int mobSpawnerAvoidanceRadius = 16;
    /** Mob avoidance coefficient (>1 avoids, <1 attracts). */
    public double mobAvoidanceCoefficient = 1.5;
    /** Mob avoidance radius, in blocks. */
    public int mobAvoidanceRadius = 8;

    // ==================== Search ====================

    /** Heuristic weight: the optimistic per-block cost of sprinting the whole way. */
    public double costHeuristic = 3.563;
    /** Maximum number of unloaded-chunk border hits allowed in one search. */
    public int pathingMaxChunkBorderFetch = 50;
    /** Cost discount for moves on the previous path when replanning (suppresses path flapping). */
    public double backtrackCostFavoringCoefficient = 0.5;
    /**
     * Require a minimum improvement of 0.01 for relaxation and bestSoFar updates (stops floating-point noise
     * from repropagating).
     */
    public boolean minimumImprovementRepropagation = true;
    /** Initial capacity of the node map. */
    public int pathingMapDefaultSize = 1024;
    /** Load factor of the node map. */
    public float pathingMapLoadFactor = 0.75f;
    /** First-segment search: budget after a usable partial path is found (ms). */
    public long primaryTimeoutMS = 500;
    /** First-segment search: full budget spent when no usable result exists (ms). */
    public long failureTimeoutMS = 2000;
    /** Primary budget for follow-up segment searches (ms). */
    public long planAheadPrimaryTimeoutMS = 4000;
    /** Failure budget for follow-up segment searches (ms). */
    public long planAheadFailureTimeoutMS = 5000;
    /**
     * <b>Runaway safety net</b> for nodes expanded in one A* search, not a regular limit. Normal searches are
     * bounded by time budgets ({@link #primaryTimeoutMS} etc.): a search explores until its budget runs out,
     * and CPU use is bounded by the fixed-size pool and low-priority threads. The value is high enough that
     * the 5 s budget always fires first (mining searches run about 50,000 nodes/s, so about 250,000 in 5 s),
     * so it <b>never fires</b> in normal play and only guards against a pathological loop that time checks
     * fail to stop.
     *
     * <p><b>Do not use it as a node cap to save CPU</b>: large composite mining goals (dozens of ores at
     * once) have weak heuristic guidance and often need more than 50,000 nodes; cutting there misreports "no
     * path", blacklists nearby ores, and sends the Bot farther away. CPU is the pool's and thread priority's
     * job. When hit (very rarely) it returns the current best partial path, the same as a timeout.
     */
    public int maxNodesPerSearch = 2_000_000;

    // ==================== Path / segmentation ====================

    /** Cut paths at the loaded-chunk boundary (off by default). */
    public boolean cutoffAtLoadBoundary = false;
    /** Partial-path cutoff factor (segment tails are low quality; drop 10%). */
    public double pathCutoffFactor = 0.9;
    /** Minimum path length before the tail cutoff applies. */
    public int pathCutoffMinimumLength = 30;
    /** Start planning the next segment when remaining cost drops below this many ticks. */
    public int planningTickLookahead = 150;
    /** Splice the next segment into the current path. */
    public boolean splicePath = true;
    /** Maximum length of the executed-path history. */
    public int maxPathHistoryLength = 300;
    /** Number of leading steps dropped when the history exceeds its limit. */
    public int pathHistoryCutoffAmount = 50;
    /** Cancel the current segment when the goal becomes invalid. */
    public boolean cancelOnGoalInvalidation = true;

    // ==================== Execution ====================

    /** Abort a movement estimated in an unloaded chunk if its cost rises by more than this once loaded. */
    public double maxCostIncrease = 10.0;
    /** Number of steps ahead whose cost is re-verified when entering a new movement. */
    public int costVerificationLookahead = 5;
    /** A movement that exceeds its estimate by this many ticks is considered stuck. */
    public int movementTimeoutTicks = 100;
    /** Allow sprinting through traverse-to-ascend jumps. */
    public boolean sprintAscends = true;
    /** A traverse that overshoots by 1-2 blocks still succeeds (no braking and turning back). */
    public boolean overshootTraverse = true;
    /** Allow a sprinting descend to overshoot into a diagonal step. */
    public boolean allowOvershootDiagonalDescend = true;
    /** Allow sprinting in water. */
    public boolean sprintInWater = true;
    /** Keep walking toward the target while preparing to break. */
    public boolean walkWhileBreaking = true;
    /** Pause mining while a falling-block entity overhead settles. */
    public boolean pauseMiningForFallingBlocks = true;
    /** Block interaction reach. */
    public double blockReachDistance = 4.5;
    /** Delay between consecutive block breaks, in ticks. */
    public int blockBreakSpeed = 6;
    /** Delay between consecutive right-clicks, in ticks. */
    public int rightClickSpeed = 4;

    // ==================== Block / item lists (lazy; registry touched on first access) ====================

    private List<Block> blocksToAvoid;
    private List<Block> blocksToAvoidBreaking;
    private List<Block> allowBreakAnyway;
    private List<Block> buildIgnoreBlocks;
    private List<Block> okIfAir;
    private List<String> buildIgnoreProperties;
    private Map<Block, List<Block>> buildValidSubstitutes;

    /** Blocks never walked through (extra blocklist). */
    public List<Block> blocksToAvoid() {
        if (blocksToAvoid == null) {
            blocksToAvoid = new ArrayList<>();
        }
        return blocksToAvoid;
    }

    /** Functional blocks to avoid breaking: break cost is multiplied by 1/{@link #avoidBreakingMultiplier}. */
    public List<Block> blocksToAvoidBreaking() {
        if (blocksToAvoidBreaking == null) {
            blocksToAvoidBreaking = new ArrayList<>(List.of(
                    Blocks.CRAFTING_TABLE, Blocks.FURNACE, Blocks.CHEST, Blocks.TRAPPED_CHEST));
        }
        return blocksToAvoidBreaking;
    }

    /** Blocks that may still be broken when {@link #allowBreak} is off. */
    public List<Block> allowBreakAnyway() {
        if (allowBreakAnyway == null) {
            allowBreakAnyway = new ArrayList<>();
        }
        return allowBreakAnyway;
    }

    /** Existing blocks still acceptable where the target is air. */
    public List<Block> buildIgnoreBlocks() {
        if (buildIgnoreBlocks == null) {
            buildIgnoreBlocks = new ArrayList<>();
        }
        return buildIgnoreBlocks;
    }

    /** Target block types for which existing air is acceptable. */
    public List<Block> okIfAir() {
        if (okIfAir == null) {
            okIfAir = new ArrayList<>();
        }
        return okIfAir;
    }

    /** Block-state property names ignored when checking build validity. */
    public List<String> buildIgnoreProperties() {
        if (buildIgnoreProperties == null) {
            buildIgnoreProperties = new ArrayList<>();
        }
        return buildIgnoreProperties;
    }

    /** Map from target block to acceptable substitute blocks. */
    public Map<Block, List<Block>> buildValidSubstitutes() {
        if (buildValidSubstitutes == null) {
            buildValidSubstitutes = new HashMap<>();
        }
        return buildValidSubstitutes;
    }
}
