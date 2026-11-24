package dev.mcagent.runtime.core.pathing.settings;

import dev.mcagent.runtime.knowledge.CanonicalIdentifierGlob;
import dev.mcagent.runtime.knowledge.CanonicalIdentifierMatcher;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

/**
 * Blocks the Bot is willing to spend as scaffolding: <b>one policy per Runtime Bot, kept only for the
 * current World Run</b>. Pillaring, bridging, and stepping up take material from here, and so do reflexes
 * (fleeing, getting unstuck, fall recovery).
 *
 * <h2>Why not a hard-coded list</h2>
 * What counts as junk cannot be enumerated in advance: modded worlds carry stone types the code does not
 * know, and the same cobblestone is junk in a mine but the only scaffolding in the End. So the Bot manages the
 * list itself: the Agent edits it with {@code manage_scaffold_materials} based on its inventory and
 * situation, and a material-shortage result lists the candidates.
 *
 * <h2>An empty list means empty</h2>
 * After clearing, the Bot places nothing. That is a legitimate decision (keep the dirt for building, not
 * for filling holes), visible and reversible. "Never set" is resolved to this class's factory default at
 * read time; the empty list does not double as that state.
 *
 * <h2>Factory-default selection criteria</h2>
 * Abundant, non-functional, and <b>does not fall when placed</b>: no gravity blocks (sand/gravel), which drop
 * straight down when placed in mid-air. Overrides are kept only in process memory and are cleared when the
 * World Run ends.
 */
public final class ScaffoldMaterials {

    public static final int MAX_GLOBS = 16;
    public static final int MAX_EFFECTIVE_ITEMS = 128;

    private static final List<String> DEFAULT_GLOBS = List.of(
            "minecraft:*dirt",
            "minecraft:cobble*e",
            "minecraft:stone",
            "minecraft:netherrack",
            "minecraft:?nd?s*e",
            "minecraft:????ite",
            "minecraft:tuff",
            "minecraft:deepslate",
            "minecraft:podzol",
            "minecraft:mud",
            "minecraft:mossy_cobblestone",
            "minecraft:grass_block",
            "minecraft:mycelium",
            "minecraft:blackstone",
            "minecraft:basalt",
            "minecraft:s???_*o??"
    );
    private static final Map<java.util.UUID, Policy> OVERRIDES = new java.util.HashMap<>();
    private static volatile Policy factoryDefaultPolicy;

    static {
        dev.mcagent.runtime.platform.ServerLifecycle.onStopped(ScaffoldMaterials::dropAll);
    }

    private ScaffoldMaterials() {}

    public enum FailureType {
        INVALID_ITEM_ID_GLOB,
        NO_BLOCK_ITEM_MATCH,
        TOO_MANY_ITEM_ID_GLOBS,
        TOO_MANY_EFFECTIVE_ITEMS
    }

    public static final class PolicyException extends IllegalArgumentException {
        private final FailureType failureType;

        private PolicyException(FailureType failureType, String message) {
            super(message);
            this.failureType = failureType;
        }

        public FailureType failureType() {
            return failureType;
        }
    }

    private record Policy(List<String> globs, List<Item> effectiveItems,
                          List<String> effectiveIds) {}

    /** Ordered factory-default Canonical ID Globs. */
    public static List<String> factoryDefaultGlobs() {
        return DEFAULT_GLOBS;
    }

    /**
     * Scaffolding items this Bot accepts. After a clear this is empty and the Bot places nothing, as
     * requested.
     */
    public static List<Item> of(ServerPlayer player) {
        return policyOf(player).effectiveItems();
    }

    /** Same as {@link #of}, as item ids (for tool results). */
    public static List<String> effectiveIds(ServerPlayer player) {
        return policyOf(player).effectiveIds();
    }

    /** The stored Globs as-is; the factory default when this Bot has no override. */
    public static synchronized List<String> storedGlobs(ServerPlayer player) {
        return policyOf(player).globs();
    }

    /**
     * Atomically validate, expand, cache, and store this ordered Glob policy. An empty list is the
     * explicit clear state; every invalid or over-broad candidate throws before the prior policy changes.
     */
    public static synchronized void store(ServerPlayer player, List<String> globs) {
        if (player == null) throw new NullPointerException("player");
        Policy candidate = compilePolicy(globs);
        OVERRIDES.put(player.getUUID(), candidate);
    }

    /** Validate and deduplicate one requested Glob list without changing any Runtime Bot policy. */
    public static List<String> validateGlobs(List<String> globs) {
        return compilePolicy(globs).globs();
    }

    private static synchronized void dropAll() {
        OVERRIDES.clear();
    }

    private static synchronized Policy policyOf(ServerPlayer player) {
        if (player == null) return factoryDefaultPolicy();
        return OVERRIDES.getOrDefault(player.getUUID(), factoryDefaultPolicy());
    }

    private static Policy factoryDefaultPolicy() {
        Policy cached = factoryDefaultPolicy;
        if (cached != null) return cached;
        synchronized (ScaffoldMaterials.class) {
            cached = factoryDefaultPolicy;
            if (cached == null) {
                cached = compilePolicy(DEFAULT_GLOBS);
                factoryDefaultPolicy = cached;
            }
            return cached;
        }
    }

    private static Policy compilePolicy(List<String> requestedGlobs) {
        List<String> source = requestedGlobs == null ? List.of() : requestedGlobs;
        LinkedHashSet<String> unique = new LinkedHashSet<>(source.size());
        for (String glob : source) {
            if (glob == null || glob.isEmpty()) {
                throw failure(FailureType.INVALID_ITEM_ID_GLOB,
                        "Scaffold Material Globs must contain 1 to 256 canonical Glob characters");
            }
            unique.add(glob);
        }
        if (unique.size() > MAX_GLOBS) {
            throw failure(FailureType.TOO_MANY_ITEM_ID_GLOBS,
                    "Scaffold Material policy may contain at most " + MAX_GLOBS + " Globs");
        }

        LinkedHashSet<Item> effective = new LinkedHashSet<>();
        for (String glob : unique) {
            CanonicalIdentifierMatcher matcher;
            try {
                matcher = CanonicalIdentifierGlob.compile(glob);
            } catch (IllegalArgumentException invalid) {
                throw failure(FailureType.INVALID_ITEM_ID_GLOB,
                        "Invalid Scaffold Material Glob '" + glob + "': " + invalid.getMessage());
            }
            int before = effective.size();
            int matches = 0;
            for (Item item : BuiltInRegistries.ITEM) {
                if (!(item instanceof BlockItem blockItem)
                        || blockItem.getBlock() == Blocks.AIR
                        || !matcher.matches(idOf(item))) {
                    continue;
                }
                matches++;
                effective.add(item);
                if (effective.size() > MAX_EFFECTIVE_ITEMS) {
                    throw failure(FailureType.TOO_MANY_EFFECTIVE_ITEMS,
                            "Scaffold Material Globs authorize more than "
                                    + MAX_EFFECTIVE_ITEMS + " unique BlockItems");
                }
            }
            if (matches == 0) {
                throw failure(FailureType.NO_BLOCK_ITEM_MATCH,
                        "Scaffold Material Glob '" + glob + "' matches no non-air BlockItem");
            }
            // A Glob may overlap only prior matches. It still has BlockItem meaning and is valid;
            // duplicate configured strings themselves were removed above without reordering.
            if (effective.size() < before) throw new AssertionError("effective union shrank");
        }
        List<Item> items = List.copyOf(effective);
        return new Policy(List.copyOf(unique), items,
                items.stream().map(ScaffoldMaterials::idOf).toList());
    }

    private static PolicyException failure(FailureType type, String message) {
        return new PolicyException(type, message);
    }

    public static String idOf(Item item) {
        return BuiltInRegistries.ITEM.getKey(item).toString();
    }

    /**
     * Advice for a failed path, given only when the Bot <b>has no accepted scaffolding at all</b>; otherwise
     * returns null (the path failed for another reason, and the Agent should not be misled).
     *
     * <p>"Out of material" alone is not actionable: the list is the Bot's own, and blocks in the inventory
     * that are not on it go unnoticed. So the advice shows both the list and the carried blocks, turning a
     * list omission into something the Agent can fix.
     */
    public static String shortageAdvice(ServerPlayer player) {
        List<Item> accepted = of(player);
        if (accepted.isEmpty()) {
            return " Your scaffolding list is EMPTY, so pathfinding may not place a single block —"
                    + " no pillaring, bridging or stepping up. That was your own call; put blocks"
                    + " back with manage_scaffold_materials if this route needs them.";
        }
        var inv = player.getInventory();
        Map<String, Integer> spare = new LinkedHashMap<>();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack stack = inv.getItem(i);
            if (stack.isEmpty()) {
                continue;
            }
            if (accepted.contains(stack.getItem())) {
                return null;   // has material; the path failed for another reason
            }
            if (stack.getItem() instanceof BlockItem) {
                spare.merge(idOf(stack.getItem()), stack.getCount(), Integer::sum);
            }
        }
        String carrying = spare.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue(), a.getValue()))
                .limit(6)
                .map(e -> e.getKey() + "×" + e.getValue())
                .reduce((a, b) -> a + ", " + b)
                .orElse("");
        StringBuilder out = new StringBuilder(" You are carrying NONE of your scaffolding materials (")
                .append(String.join(", ", effectiveIds(player)))
                .append("), so pathfinding could not pillar, bridge or step anywhere.");
        if (carrying.isEmpty()) {
            return out.append(" Mine some of those blocks first.").toString();
        }
        return out.append(" You ARE carrying: ").append(carrying)
                .append(". Add what you are willing to spend with manage_scaffold_materials, or go mine "
                        + "something already on the list.").toString();
    }

}
