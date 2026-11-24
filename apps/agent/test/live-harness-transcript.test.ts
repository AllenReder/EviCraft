import { describe, expect, it } from "vitest";

import { createLiveHarnessTranscript, type HarnessProgressEvent } from "../src/index.js";

describe("Live Harness Transcript", () => {
  it("shows readable reasoning only in verbose mode", () => {
    const ordinary: string[] = [];
    const verbose: string[] = [];
    const event = { type: "model_reasoning" as const, requestId: "request-1", text: "Inspect first." };
    createLiveHarnessTranscript({ color: false, verbose: false, write: (value) => ordinary.push(value) }).render(event);
    createLiveHarnessTranscript({ color: false, verbose: true, write: (value) => verbose.push(value) }).render(event);

    expect(ordinary).toEqual([]);
    expect(verbose.join("\n")).toContain("REASONING\n           Inspect first.");
    expect(verbose.join("\n")).not.toContain("replayState");
  });

  it("shows concise compaction and context-recovery progress", () => {
    const lines: string[] = [];
    const transcript = createLiveHarnessTranscript({
      color: false, verbose: false, now: () => new Date(2026, 7, 15, 5, 31, 2),
      write: (value) => { lines.push(value); },
    });

    transcript.render({ type: "model_context_overflow", retry: 1 });
    transcript.render({ type: "history_compaction", removedCycles: 1, retry: 1 });

    expect(lines.join("\n")).toContain("MODEL CONTEXT OVERFLOW · compacting and retrying");
    expect(lines.join("\n")).toContain("HISTORY COMPACTED · removed 1 older Tool Cycles");
  });

  it("renders the Operating Contract once with a summarized generated SDK", () => {
    const lines: string[] = [];
    const transcript = createLiveHarnessTranscript({
      color: false,
      verbose: false,
      now: () => new Date(2026, 7, 15, 5, 31, 2),
      write: (value) => { lines.push(value); },
    });
    transcript.render({
      type: "operating_contract",
      mode: "code",
      sections: [
        {
          title: "Harness Contract",
          summary: "Generated Code SDK · 37 abilities · 5766 lines",
          body: "<harness_contract rules>\nhuge generated sdk\n</harness_contract rules>",
        },
        { title: "Project Skills", body: "none" },
        { title: "Run Goal", body: "Collect wood." },
      ],
      wireText: "<harness_contract>\nhuge generated sdk\n</harness_contract>",
    });

    const output = lines.join("\n");
    expect(output).toContain("OPERATING CONTRACT");
    expect(output).toContain("Generated Code SDK · 37 abilities · 5766 lines");
    expect(output).toContain("Collect wood.");
    expect(output).not.toContain("huge generated sdk");
    expect(output).not.toContain("wire=");
  });

  it("appends the verbatim wire text of stable and fresh content in verbose mode", () => {
    const lines: string[] = [];
    const transcript = createLiveHarnessTranscript({
      color: false,
      verbose: true,
      now: () => new Date(2026, 7, 15, 5, 31, 2),
      write: (value) => { lines.push(value); },
    });
    transcript.render({
      type: "operating_contract",
      mode: "code",
      sections: [
        {
          title: "Harness Contract",
          summary: "Generated Code SDK · 2 abilities · 3 lines",
          body: "mode rules and sdk",
        },
        { title: "Project Skills", body: "none" },
        { title: "Run Goal", body: "Collect wood." },
      ],
      wireText: "<harness_contract>\nmode rules and sdk\n</harness_contract>",
    });
    transcript.render(decisionContextEvent());

    const output = lines.join("\n");
    expect(output).toContain("wire=<harness_contract>");
    expect(output).toContain("mode rules and sdk");
    expect(output).toContain('wire=<minecraft_pre_step_context source="fresh">');
    expect(output).toContain("</minecraft_pre_step_context>");
  });

  it("renders each Decision Context with ubiquitous-language sections", () => {
    const lines: string[] = [];
    const transcript = createLiveHarnessTranscript({
      color: false,
      verbose: false,
      now: () => new Date(2026, 7, 15, 5, 31, 2),
      write: (value) => { lines.push(value); },
    });
    transcript.render(decisionContextEvent());

    expect(lines.join("\n")).toBe([
      "05:31:02 ◉ DECISION CONTEXT · CYCLE 1",
      "           ▸ AGENT PLAN",
      "           {",
      "             \"revision\": 0,",
      "             \"items\": []",
      "           }",
      "           ▸ NAVIGATION POLICY",
      "           {",
      "             \"action\": \"read\"",
      "           }",
      "           ▸ TURN TRIGGER CONTEXT",
      "           none",
      "           ▸ TURN OBSERVATION",
      "           <turn_observation>",
      "           SELF",
      "           feet=12,64,-8",
      "           </turn_observation>",
    ].join("\n"));
  });

  it("renders Variant A as an append-only plain-text stream and hides internal queries", () => {
    const lines: string[] = [];
    const transcript = createLiveHarnessTranscript({
      color: false,
      verbose: false,
      now: () => new Date(2026, 7, 15, 5, 31, 2),
      write: (value) => { lines.push(value); },
    });
    const events: HarnessProgressEvent[] = [
      {
        type: "harness_run_started",
        runId: "run-1",
        runStartedAt: "2026-08-15T05:31:02.000Z",
        mode: "code",
        username: "TracerBot",
        model: "test-model",
      },
      decisionContextEvent(),
      {
        type: "outer_call_started",
        requestId: "request-1",
        toolCallId: "outer-1",
        tool: "run_code",
        title: "Inspect the Actor.",
        arguments: JSON.stringify({
          description: "Inspect the Actor.",
          code: "const self = await abilities.observe_self({});\nreturn self;",
        }),
      },
      {
        type: "ability_call_started",
        rootId: "automatic-root",
        executionId: "automatic-1",
        ability: "observe_self",
        execution: "query",
        depth: 1,
        input: {},
        source: "turn_observation_assembler",
      },
      {
        type: "ability_call_started",
        rootId: "harness-root",
        executionId: "harness-1",
        ability: "observe_self",
        execution: "query",
        depth: 1,
        input: {},
        source: "harness",
      },
      {
        type: "ability_call_finished",
        rootId: "harness-root",
        executionId: "harness-1",
        ability: "observe_self",
        outcome: "succeeded",
        result: { ok: true },
        durationMs: 2,
        source: "harness",
      },
      {
        type: "programmatic_execution_started",
        rootId: "agent-root",
        executionId: "programmatic-1",
        depth: 1,
        source: "agent",
      },
      {
        type: "ability_call_started",
        rootId: "agent-root",
        executionId: "agent-1",
        parentExecutionId: "programmatic-1",
        ability: "observe_self",
        execution: "query",
        depth: 2,
        input: {},
        source: "agent",
      },
      {
        type: "ability_call_finished",
        rootId: "agent-root",
        executionId: "agent-1",
        ability: "observe_self",
        outcome: "succeeded",
        result: { ok: true },
        durationMs: 38.4,
        source: "agent",
      },
      {
        type: "programmatic_execution_finished",
        rootId: "agent-root",
        executionId: "programmatic-1",
        outcome: "succeeded",
        durationMs: 40,
        source: "agent",
      },
      {
        type: "outer_call_finished",
        requestId: "request-1",
        toolCallId: "outer-1",
        tool: "run_code",
        title: "Inspect the Actor.",
        outcome: "ok",
        result: { ok: true, result: { rootId: "agent-root", logs: [], result: { ok: true } } },
        modelContent: "observed full Actor state\n{\n  \"ok\": true\n}",
        durationMs: 41.2,
      },
    ];

    for (const event of events) transcript.render(event);

    expect(lines.join("\n")).toBe([
      "05:31:02 ◆ HARNESS RUN code · TracerBot · test-model",
      "────────────────────────────────────────────────────────────────────────────────────────",
      "05:31:02 ◉ DECISION CONTEXT · CYCLE 1",
      "           ▸ AGENT PLAN",
      "           {",
      "             \"revision\": 0,",
      "             \"items\": []",
      "           }",
      "           ▸ NAVIGATION POLICY",
      "           {",
      "             \"action\": \"read\"",
      "           }",
      "           ▸ TURN TRIGGER CONTEXT",
      "           none",
      "           ▸ TURN OBSERVATION",
      "           <turn_observation>",
      "           SELF",
      "           feet=12,64,-8",
      "           </turn_observation>",
      "────────────────────────────────────────────────────────────────────────────────────────",
      "05:31:02 ▶ RUN_CODE Inspect the Actor.",
      "            1  const self = await abilities.observe_self({});",
      "            2  return self;",
      "05:31:02   ├─ observe_self query →",
      "05:31:02   ├─ observe_self query ✓ 38ms",
      "05:31:02 ✓ RUN_CODE OUTPUT · 41ms",
      "           observed full Actor state",
      "           {",
      "             \"ok\": true",
      "           }",
    ].join("\n"));
    expect(lines.join("\n")).not.toContain("automatic-root");
    expect(lines.join("\n")).not.toContain("harness-root");
    expect(lines.filter((line) => line.includes("RUN_CODE"))).toHaveLength(2);
  });

  it("expands Agent call details but hides automatic calls in verbose mode", () => {
    const lines: string[] = [];
    const transcript = createLiveHarnessTranscript({
      color: false,
      verbose: true,
      now: () => new Date(2026, 7, 15, 5, 31, 2),
      write: (value) => { lines.push(value); },
    });
    transcript.render({
      type: "ability_call_started",
      rootId: "automatic-root",
      executionId: "automatic-1",
      ability: "observe_blocks",
      execution: "query",
      depth: 1,
      input: { limit: 128 },
      source: "turn_observation_assembler",
    });
    transcript.render({
      type: "ability_call_finished",
      rootId: "automatic-root",
      executionId: "automatic-1",
      ability: "observe_blocks",
      outcome: "succeeded",
      result: { ok: true, blocks: [] },
      runtimeTrace: { request_id: "runtime-1" },
      durationMs: 12,
      source: "turn_observation_assembler",
    });
    transcript.render({
      type: "ability_call_started",
      rootId: "agent-root",
      executionId: "agent-1",
      ability: "find_known_blocks",
      execution: "query",
      depth: 1,
      input: { block_id_glob: "minecraft:*_log" },
      source: "agent",
    });
    transcript.render({
      type: "ability_call_finished",
      rootId: "agent-root",
      executionId: "agent-1",
      ability: "find_known_blocks",
      outcome: "succeeded",
      result: { ok: true, matches: [] },
      runtimeTrace: { request_id: "runtime-agent-1" },
      durationMs: 8,
      source: "agent",
    });
    transcript.render({
      type: "outer_call_finished",
      requestId: "request-1",
      toolCallId: "outer-1",
      tool: "run_code",
      title: "Inspect.",
      outcome: "ok",
      result: {
        ok: true,
        result: {
          rootId: "agent-root",
          logs: [{ stream: "stdout", text: "inspection log\n" }],
          result: { ok: true },
        },
      },
      durationMs: 20,
    });

    const output = lines.join("\n");
    expect(output).not.toContain("observe_blocks query →");
    expect(output).not.toContain("automatic-root");
    expect(output).toContain("find_known_blocks query →");
    expect(output).toContain('input={');
    expect(output).toContain('"block_id_glob": "minecraft:*_log"');
    expect(output).toContain('result={');
    expect(output).toContain('"matches": []');
    expect(output).toContain('runtime_trace={');
    expect(output).toContain('"request_id": "runtime-agent-1"');
    expect(output).toContain('"text": "inspection log\\n"');
  });

  it("renders expected domain failures separately from execution errors", () => {
    const lines: string[] = [];
    const transcript = createLiveHarnessTranscript({
      color: false,
      verbose: false,
      now: () => new Date(2026, 7, 15, 5, 31, 2),
      write: (value) => { lines.push(value); },
    });

    transcript.render({
      type: "ability_call_started",
      rootId: "agent-root",
      executionId: "agent-1",
      ability: "break_block",
      execution: "body",
      depth: 1,
      input: { position: { x: 1, y: 64, z: 2 } },
      source: "agent",
    });
    transcript.render({
      type: "ability_call_finished",
      rootId: "agent-root",
      executionId: "agent-1",
      ability: "break_block",
      outcome: "failed",
      result: {
        ok: false,
        error: "RUNTIME_FAILED",
        message: "target is out of reach",
        data: {},
      },
      durationMs: 12,
      source: "agent",
    });
    transcript.render({
      type: "ability_call_started",
      rootId: "agent-root",
      executionId: "agent-2",
      ability: "observe_self",
      execution: "query",
      depth: 1,
      input: {},
      source: "agent",
    });
    transcript.render({
      type: "ability_call_finished",
      rootId: "agent-root",
      executionId: "agent-2",
      ability: "observe_self",
      outcome: "error",
      message: "Runtime connection closed",
      durationMs: 5,
      source: "agent",
    });

    expect(lines).toEqual([
      "05:31:02 ├─ break_block body →",
      "05:31:02 ├─ break_block body ! 12ms target is out of reach",
      "05:31:02 ├─ observe_self query →",
      "05:31:02 ├─ observe_self query ✗ 5ms Runtime connection closed",
    ]);
  });

  it("uses picocolors-backed TypeScript highlighting only when color is enabled", () => {
    const lines: string[] = [];
    const transcript = createLiveHarnessTranscript({
      color: true,
      verbose: false,
      now: () => new Date(2026, 7, 15, 5, 31, 2),
      write: (value) => { lines.push(value); },
    });

    transcript.render({
      type: "outer_call_started",
      requestId: "request-1",
      toolCallId: "outer-1",
      tool: "run_code",
      title: "Inspect.",
      arguments: JSON.stringify({ description: "Inspect.", code: "const answer = 42;" }),
    });

    expect(lines.join("\n")).toContain("\u001B[35mconst\u001B[39m");
  });
});


function decisionContextEvent(): Extract<HarnessProgressEvent, { type: "decision_context" }> {
  return {
    type: "decision_context",
    cycle: 1,
    sections: [
      { title: "Agent Plan", body: "{\n  \"revision\": 0,\n  \"items\": []\n}" },
      { title: "Navigation Policy", body: "{\n  \"action\": \"read\"\n}" },
      { title: "Turn Trigger Context", body: "none" },
      {
        title: "Turn Observation",
        body: "<turn_observation>\nSELF\nfeet=12,64,-8\n</turn_observation>",
      },
    ],
    wireText: '<minecraft_pre_step_context source="fresh">\n{}\n</minecraft_pre_step_context>',
  };
}
