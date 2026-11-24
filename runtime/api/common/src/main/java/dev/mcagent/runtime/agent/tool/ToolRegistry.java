package dev.mcagent.runtime.agent.tool;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Mod-global registry of {@link RuntimeTool} instances. Populated once during
 * mod init (see {@code CommonClass.init} / per-loader entry points) and
 * read-only thereafter. Insertion order is preserved so the LLM sees tools
 * in a stable order across requests — useful for prompt caching on backends
 * that hash tool definitions.
 *
 * <h2>Why static singleton instead of per-entity</h2>
 * The tool set is a deployment-level decision (which capabilities does the
 * mod expose?), not a per-entity decision. Putting it on the entity would
 * mean every Bot carries an identical copy, wasting memory and creating
 * a sync question (does each entity get its own ToolRegistry? on world load
 * do they get repopulated?). Global is simpler and matches how vanilla
 * registries work.
 */
public final class ToolRegistry {

    private static final Map<String, RuntimeTool> TOOLS = new LinkedHashMap<>();

    private ToolRegistry() {}

    /** Function-name shape the LLM API accepts. An illegal name rejects the whole request, not just one tool. */
    private static final java.util.regex.Pattern LEGAL_NAME =
            java.util.regex.Pattern.compile("[a-zA-Z0-9_-]{1,64}");

    /**
     * Register a tool. Should only be called during mod init. Throws on
     * duplicate name — silent replacement would mask wiring bugs.
     *
     * <p>The name shape is checked here too. The tool list goes out with every request, so one illegal
     * name costs a 400 for the whole turn rather than one unusable tool; failing at registration is
     * better than letting it in. Built-in tools hit this at init; borrowed tools are caught and skipped
     * by the caller (see {@code McpClientManager}).
     */
    public static void register(RuntimeTool tool) {
        String name = tool.name();
        if (name == null || !LEGAL_NAME.matcher(name).matches()) {
            throw new IllegalArgumentException(
                    "Invalid tool name (only [a-zA-Z0-9_-], 1-64 characters allowed): '" + name
                            + "' — " + tool.getClass().getName());
        }
        RuntimeTool prior = TOOLS.put(name, tool);
        if (prior != null) {
            throw new IllegalStateException(
                    "Duplicate RuntimeTool name: " + name
                            + " (was " + prior.getClass().getName()
                            + ", now " + tool.getClass().getName() + ")");
        }
    }

    /**
     * Remove a tool by name; returns the removed tool, or {@code null} if none
     * was registered under that name.
     *
     * <p>Used by the MCP client's live enable/disable: disabling a server pulls
     * its borrowed tools back out so the built-in brain stops seeing them on the
     * next turn ({@code EntityAgentLoop} re-reads {@link #all()} every turn). Must
     * be called on the client main thread — same invariant as {@link #all()},
     * since the backing map is not synchronized.
     */
    public static RuntimeTool remove(String name) {
        return TOOLS.remove(name);
    }

    public static RuntimeTool get(String name) {
        return TOOLS.get(name);
    }

    /**
     * Lenient lookup — exact match first, then case-insensitive fallback.
     * Mirrors opencode's {@code experimental_repairToolCall} pattern
     * ({@code llm.ts:331-350}) where mis-cased tool names from the LLM
     * are silently fixed instead of crashing the turn.
     *
     * <p>Most LLM typo failure modes come from case drift
     * ({@code Move_to} vs {@code move_to}, {@code AssignTask} vs
     * {@code assign_task}); a single lowercase compare catches them all.
     * For names that still don't resolve, callers should surface a
     * structured "unknown tool" error so the LLM can self-correct on
     * the next turn.
     */
    public static RuntimeTool resolve(String name) {
        if (name == null) return null;
        RuntimeTool exact = TOOLS.get(name);
        if (exact != null) return exact;
        String lower = name.toLowerCase();
        if (lower.equals(name)) return null;  // already lowercase, no further fallback
        return TOOLS.get(lower);
    }

    /**
     * All registered tools, in registration order. Fed to each LLM call.
     * A copy, so callers can pass it to APIs expecting a mutable {@link List}.
     */
    public static List<RuntimeTool> all() {
        return new ArrayList<>(TOOLS.values());
    }

    public static int size() {
        return TOOLS.size();
    }
}
