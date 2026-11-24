/**
 * <strong>Public API.</strong> {@link ToolContext} — the per-call context (the
 * tool-call id plus a deadline helper) a server-side tool uses when building a
 * task record.
 *
 * <p>There is no reflective annotation-based authoring layer: a tool is just a
 * {@link dev.mcagent.runtime.agent.tool.RuntimeTool} (name, description, schema,
 * {@code invoke}). core module provides optional authoring sugar (a {@code Schema}
 * builder and a {@code TaskDispatch} helpers) for packs that want them.
 */
package dev.mcagent.runtime.agent.tool.api;
