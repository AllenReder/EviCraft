import { highlight } from "cli-highlight";
import picocolors from "picocolors";

import { harnessControlToolNames } from "./control-tool-names.js";
import type { HarnessProgressEvent } from "./run-harness.js";

export interface LiveHarnessTranscriptOptions {
  readonly verbose: boolean;
  readonly color: boolean;
  readonly write: (value: string) => void;
  readonly now?: () => Date;
}

export interface LiveHarnessTranscript {
  render(event: HarnessProgressEvent): void;
}

const RULE = "─".repeat(88);
const CONTENT_INDENT = "           ";

export function createLiveHarnessTranscript(options: LiveHarnessTranscriptOptions): LiveHarnessTranscript {
  const colors = picocolors.createColors(options.color);
  const now = options.now ?? (() => new Date());
  const calls = new Map<string, Readonly<{ depth: number; execution: string }>>();
  const { write } = options;

  const time = () => colors.dim(localTime(now()));
  const renderDecisionSections = (
    heading: string,
    sections: readonly Readonly<{ title: string; summary?: string; body: string }>[],
    wireText: string | undefined,
  ): string => {
    const lines = [heading];
    for (const section of sections) {
      lines.push(indent(`${colors.blue("▸")} ${colors.bold(section.title.toUpperCase())}`));
      lines.push(indent(section.summary ?? section.body));
    }
    if (wireText !== undefined) lines.push(indent(`wire=${wireText}`));
    return lines.join("\n");
  };
  const render = (event: HarnessProgressEvent): void => {
    switch (event.type) {
      case "harness_run_started":
        write([
          `${time()} ${colors.blue("◆")} ${colors.bold("HARNESS RUN")} ${colors.dim(`${event.mode} · ${event.username} · ${event.model}`)}`,
          colors.dim(RULE),
        ].join("\n"));
        return;
      case "operating_contract":
        write(renderDecisionSections(
          `${time()} ${colors.blue("◆")} ${colors.blue(colors.bold("OPERATING CONTRACT"))} ${colors.dim("shown once")}`,
          event.sections,
          options.verbose ? event.wireText : undefined,
        ));
        return;
      case "decision_context":
        write(renderDecisionSections(
          `${time()} ${colors.blue("◉")} ${colors.blue(colors.bold(`DECISION CONTEXT · CYCLE ${event.cycle}`))}`,
          event.sections,
          options.verbose ? event.wireText : undefined,
        ));
        return;
      case "model_reasoning":
        if (options.verbose) {
          write(`${time()} ${colors.dim("◇ REASONING")}\n${indent(event.text)}`);
        }
        return;
      case "model_context_overflow":
        write(`${time()} ${colors.yellow("!")} ${colors.bold("MODEL CONTEXT OVERFLOW")} · compacting and retrying`);
        return;
      case "history_compaction":
        write(`${time()} ${colors.blue("◇")} ${colors.bold("HISTORY COMPACTED")} · removed ${event.removedCycles} older Tool Cycles`);
        return;
      case "outer_call_started":
        write(renderOuterCallStarted(event, time(), colors, options.color));
        return;
      case "programmatic_execution_started":
      case "programmatic_execution_finished":
        return;
      case "ability_call_started": {
        if (event.source !== "agent") return;
        calls.set(
          executionKey(event.rootId, event.executionId),
          { depth: event.depth, execution: event.execution },
        );
        const branch = abilityBranch(event.depth);
        const line = `${time()} ${colors.cyan(branch)} ${event.ability} ${colors.dim(event.execution)} ${colors.yellow("→")}`;
        write(options.verbose ? `${line}\n${indent(`input=${pretty(event.input)}`)}` : line);
        return;
      }
      case "ability_call_finished": {
        if (event.source !== "agent") return;
        const key = executionKey(event.rootId, event.executionId);
        const started = calls.get(key);
        calls.delete(key);
        const branch = abilityBranch(started?.depth ?? 1);
        const execution = started?.execution ?? "ability";
        const marker = event.outcome === "succeeded"
          ? colors.green("✓")
          : event.outcome === "failed"
            ? colors.yellow("!")
            : colors.red("✗");
        const line = `${time()} ${colors.cyan(branch)} ${event.ability} ${colors.dim(execution)} ${marker} ${formatDuration(event.durationMs)}`;
        if (!options.verbose) {
          if (event.outcome === "failed") {
            const message = canonicalAbilityMessage(event.result);
            write(message === undefined ? line : `${line} ${colors.yellow(message)}`);
            return;
          }
          write(event.outcome === "error" && event.message !== undefined ? `${line} ${colors.red(event.message)}` : line);
          return;
        }
        const details = [
          ...(Object.hasOwn(event, "result") ? [`result=${pretty(event.result)}`] : []),
          ...(event.message === undefined ? [] : [`message=${event.message}`]),
          ...(event.runtimeTrace === undefined ? [] : [`runtime_trace=${pretty(event.runtimeTrace)}`]),
        ];
        write(details.length === 0 ? line : `${line}\n${indent(details.join("\n"))}`);
        return;
      }
      case "outer_call_finished":
        write(renderOuterCallFinished(event, time(), colors, options.verbose));
    }
  };

  return { render };
}

type Colors = ReturnType<typeof picocolors.createColors>;

function renderOuterCallStarted(
  event: Extract<HarnessProgressEvent, { type: "outer_call_started" }>,
  time: string,
  colors: Colors,
  color: boolean,
): string {
  const heading = `${time} ${colors.magenta("▶")} ${colors.bold(event.tool.toUpperCase())} ${colors.yellow(event.title)}`;
  if (event.tool !== harnessControlToolNames.runCode) return `${colors.dim(RULE)}\n${heading}`;
  const input = runCodeInput(event.arguments);
  if (input === undefined) return `${colors.dim(RULE)}\n${heading}\n${indent(event.arguments)}`;
  return [
    colors.dim(RULE),
    `${time} ${colors.magenta("▶")} ${colors.bold("RUN_CODE")} ${colors.yellow(input.description)}`,
    renderCode(input.code, colors, color),
  ].join("\n");
}

function renderOuterCallFinished(
  event: Extract<HarnessProgressEvent, { type: "outer_call_finished" }>,
  time: string,
  colors: Colors,
  verbose: boolean,
): string {
  const interrupted = event.outcome === "interrupted";
  if (event.tool !== harnessControlToolNames.runCode) {
    const marker = event.outcome === "ok" ? colors.green("✓")
      : interrupted ? colors.yellow("◆")
      : colors.red("✗");
    return `${time} ${marker} ${colors.bold(event.tool.toUpperCase())} · ${formatDuration(event.durationMs)}`;
  }
  if (event.outcome === "ok") {
    const line = `${time} ${colors.green("✓")} ${colors.bold("RUN_CODE OUTPUT")} · ${formatDuration(event.durationMs)}`;
    const output = event.modelContent ?? pretty(returnedValue(event.result));
    const rendered = `${line}\n${indent(output)}`;
    return verbose ? `${rendered}\n${indent(`outer_result=${pretty(event.result)}`)}` : rendered;
  }
  if (interrupted) {
    const line = `${time} ${colors.yellow("◆")} ${colors.bold("RUN_CODE INTERRUPTED")} · ${formatDuration(event.durationMs)}`;
    const output = event.modelContent === undefined ? line : `${line}\n${indent(event.modelContent)}`;
    return verbose ? `${output}\n${indent(`outer_result=${pretty(event.result)}`)}` : output;
  }
  const line = `${time} ${colors.red("✗")} ${colors.bold("RUN_CODE FAILED")} ${colors.red(compact(event.result))} · ${formatDuration(event.durationMs)}`;
  return verbose ? `${line}\n${indent(`outer_result=${pretty(event.result)}`)}` : line;
}

function canonicalAbilityMessage(result: unknown): string | undefined {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
  const message = (result as Readonly<Record<string, unknown>>).message;
  return typeof message === "string" && message.trim() !== "" ? message : undefined;
}

function runCodeInput(argumentsJson: string): Readonly<{ description: string; code: string }> | undefined {
  try {
    const value = JSON.parse(argumentsJson) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Readonly<Record<string, unknown>>;
    return typeof input.description === "string" && typeof input.code === "string"
      ? { description: input.description, code: input.code }
      : undefined;
  } catch {
    return undefined;
  }
}

function renderCode(code: string, colors: Colors, color: boolean): string {
  const rendered = color ? highlight(code, {
    language: "typescript",
    ignoreIllegals: true,
    theme: {
      keyword: colors.magenta,
      built_in: colors.cyan,
      type: colors.yellow,
      literal: colors.blue,
      number: colors.green,
      string: colors.cyan,
      comment: colors.gray,
      title: colors.yellow,
      function: colors.yellow,
    },
  }) : code;
  return rendered.split("\n").map((line, index) =>
    `${CONTENT_INDENT}${colors.dim(String(index + 1).padStart(2))}  ${line}`).join("\n");
}

function returnedValue(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.result) || !Object.hasOwn(value.result, "result")) return value;
  return value.result.result;
}

function abilityBranch(depth: number): string {
  return `${"  ".repeat(Math.max(0, depth - 1))}├─`;
}

function executionKey(rootId: string, executionId: string): string {
  return `${rootId}:${executionId}`;
}

function localTime(value: Date): string {
  return [value.getHours(), value.getMinutes(), value.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(2)}s`;
}

function indent(value: string): string {
  return value.split("\n").map((line) => `${CONTENT_INDENT}${line}`).join("\n");
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function compact(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
