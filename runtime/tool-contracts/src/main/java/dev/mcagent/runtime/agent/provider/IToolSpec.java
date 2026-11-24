package dev.mcagent.runtime.agent.provider;

import java.util.Map;

/**
 * Read-only, LLM-facing description of a tool: everything a provider needs to serialize the
 * {@code tools} array. The connection layer reads only these three members. How and in which
 * process a tool runs belongs to the engine-side {@code RuntimeTool}; the connection layer never sees it.
 */
public interface IToolSpec {

    /** Tool name as the LLM sees it. {@code snake_case}. */
    String name();

    /**
     * Description shown to the LLM — the single biggest lever on whether the model
     * picks this tool correctly. Cover what it does, WHEN to use it (and when not),
     * what each non-obvious parameter means, and any caveat.
     */
    String description();

    /** JSON Schema (OpenAI tool-parameter dialect) for the tool's arguments. */
    Map<String, Object> parameterSchema();
}
