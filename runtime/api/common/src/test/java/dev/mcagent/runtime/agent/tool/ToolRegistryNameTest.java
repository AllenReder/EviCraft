package dev.mcagent.runtime.agent.tool;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * The registry's tool-name check.
 *
 * <p>Why the gate sits in the registry rather than in each source: the tool list goes out <b>with every
 * request</b>. One name the LLM API rejects costs a 400 for the whole turn, not one unusable tool, and
 * every later request from the Bot fails too. Names come from several sources (built-in, borrowed over
 * MCP, others), so one check here is more reliable than relying on each source to sanitize.
 */
class ToolRegistryNameTest {

    /** A tool that is only a name; these cases only exercise the name gate. */
    private record Fake(String name) implements RuntimeTool {
        @Override public String description() { return "test"; }
        @Override public Map<String, Object> parameterSchema() { return Map.of(); }
    }

    private void removeQuietly(String name) {
        try {
            ToolRegistry.remove(name);
        } catch (RuntimeException ignored) {
            // Nothing to clean up if it was never registered.
        }
    }

    @AfterEach
    void cleanUp() {
        for (String n : new String[]{"ok_name", "ok-name-2", "dup_name", "a".repeat(64)}) {
            removeQuietly(n);
        }
    }

    @Test
    void legalNamesGoIn() {
        ToolRegistry.register(new Fake("ok_name"));
        ToolRegistry.register(new Fake("ok-name-2"));
        assertNotNull(ToolRegistry.get("ok_name"));
        assertNotNull(ToolRegistry.get("ok-name-2"));
    }

    @Test
    void aNameAtTheLimitIsStillFine() {
        ToolRegistry.register(new Fake("a".repeat(64)));
        assertNotNull(ToolRegistry.get("a".repeat(64)));
    }

    @Test
    void illegalCharactersAreRefusedAtTheDoor() {
        // Dots are the most common case from MCP: browser.navigate
        for (String bad : new String[]{"has.dot", "has space", "中文", "emoji_🙂", "has/slash", ""}) {
            assertThrows(IllegalArgumentException.class,
                    () -> ToolRegistry.register(new Fake(bad)), "this name should be rejected: '" + bad + "'");
            assertNull(ToolRegistry.get(bad), "a rejected name must not stay in the registry: '" + bad + "'");
        }
    }

    @Test
    void anOverlongNameIsRefused() {
        String tooLong = "a".repeat(65);
        assertThrows(IllegalArgumentException.class, () -> ToolRegistry.register(new Fake(tooLong)));
        assertNull(ToolRegistry.get(tooLong));
    }

    @Test
    void duplicatesStillThrowSoWiringBugsDoNotHideBehindTheNameCheck() {
        ToolRegistry.register(new Fake("dup_name"));
        assertThrows(IllegalStateException.class, () -> ToolRegistry.register(new Fake("dup_name")));
    }

    @Test
    void everyBuiltInToolAlreadySatisfiesTheRule() {
        // Built-in tools already hit this gate at init; this pins the rule for tools added later.
        for (String name : ToolRegistry.all().stream().map(RuntimeTool::name).toList()) {
            assertEquals(name, name.replaceAll("[^a-zA-Z0-9_-]", "_"), "own tool name is invalid: " + name);
        }
    }
}
