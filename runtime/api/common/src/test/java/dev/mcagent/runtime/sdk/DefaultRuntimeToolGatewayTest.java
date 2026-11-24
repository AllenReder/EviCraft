package dev.mcagent.runtime.sdk;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class DefaultRuntimeToolGatewayTest {

    @Test
    void catalogueUsesExecutionMetadataFromExtensionToolWithoutNameLists() {
        var tool = new dev.mcagent.runtime.agent.tool.RuntimeTool() {
            public String name() { return "extension_body_action"; }
            public String description() { return "extension action"; }
            public java.util.Map<String, Object> parameterSchema() { return java.util.Map.of("type", "object"); }
            public Execution execution() { return Execution.BODY; }
        };
        var gateway = new DefaultRuntimeToolGateway(() -> List.of(tool), () -> null);
        assertEquals("body", gateway.list().getFirst().execution());
        assertEquals("extension_body_action", gateway.list().getFirst().name());
    }

    @Test
    void unknownToolReturnsStableOrdinaryTaskFailure() {
        DefaultRuntimeToolGateway gateway = new DefaultRuntimeToolGateway(List::of, () -> null);
        AtomicReference<String> terminal = new AtomicReference<>();

        gateway.call(JsonParser.parseString("\"request-1\""), "locate_structure",
                new JsonObject(), terminal::set);

        JsonObject result = JsonParser.parseString(terminal.get()).getAsJsonObject();
        assertFalse(result.get("success").getAsBoolean());
        assertEquals("unknown Runtime Tool: locate_structure",
                result.get("message").getAsString());
        assertEquals("unknown_tool", result.get("failure_type").getAsString());
    }
}
