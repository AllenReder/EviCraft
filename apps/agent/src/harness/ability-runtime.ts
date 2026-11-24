import { AbilityBodyGate, AbilityRootExecution, CompositeProgramExecutionScope } from "./ability-execution-scheduler.js";
import { stripTypeScriptTypes } from "node:module";
import { finished } from "node:stream/promises";
import { Worker } from "node:worker_threads";

import type { RuntimeAdapter } from "./runtime-adapter.js";
import { ActorUnavailableError } from "./runtime-errors.js";
import type { AgentToolProjection } from "./model-surface-message.js";
import { RunAbilityCatalogue } from "./run-ability-catalogue.js";
import { abilitySdkOutputType } from "./canonical-ability-result.js";
import { programmaticCodeContract } from "./programmatic-code-contract.js";
import {
  defineToolContract,
  executeToolContract,
  projectToolContract,
  ToolContractError,
  type ToolContract,
} from "./tool-contract.js";
import {
  renderToolSchemaTypeScript,
  type InferToolSchema,
  type ToolSchema,
} from "./tool-schema.js";

export class ToolCallError extends Error {
  public constructor(public readonly ability: string, message: string) {
    super(message);
    this.name = "ToolCallError";
  }
}

export type ProgrammaticExecutionErrorCode =
  | "typescript_not_erasable"
  | "worker_runtime_error"
  | "worker_crash"
  | "worker_busy_timeout"
  | "worker_wall_timeout"
  | "worker_tick_timeout"
  | "output_limit"
  | "rpc_protocol_error"
  | "result_not_lossless_json"
  | "canceled";

export class ProgrammaticExecutionError extends Error {
  public logs: readonly ProgrammaticExecutionLog[] = [];
  public rootId: string | undefined;
  public executionId: string | undefined;
  public modelOutput: string | undefined;

  public constructor(
    public readonly code: ProgrammaticExecutionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProgrammaticExecutionError";
  }

  public captureOutput(
    logs: readonly ProgrammaticExecutionLog[],
    rootId: string,
    executionId: string,
    maxOutputBytes: number,
  ): this {
    this.logs = logs.map((log) => ({ ...log }));
    this.rootId = rootId;
    this.executionId = executionId;
    this.modelOutput = renderProgrammaticFailure(this, maxOutputBytes);
    return this;
  }
}

export interface AbilityExecutionContext {
  readonly signal?: AbortSignal;
  readonly invocationSource?: AbilityInvocationSource;
  readonly runtime?: RuntimeAdapter;
  readonly recordRuntimeTrace?: (trace: Readonly<Record<string, unknown>>) => void;
}

export type AbilityInvocationSource = "agent" | "turn_observation_assembler" | "harness";

export interface AbilityInvocationContext extends AbilityExecutionContext {
  readonly signal: AbortSignal;
  readonly execution: Readonly<{
    rootId: string;
    executionId: string;
    rootAbility: string;
    ability: string;
    depth: number;
    dispatchCount: number;
  }>;
}

export type AbilityConcurrency = "safe" | "exclusive";
export type AbilityExecutionKind = "query" | "body" | "composite";
type BuiltInAbilityExecutionKind = Exclude<AbilityExecutionKind, "composite">;

export interface AbilityDefinition<Name extends string, Input, Output>
  extends ToolContract<Name, ToolSchema<Input>, ToolSchema<Output>> {
  readonly concurrency: AbilityConcurrency;
  readonly execution: AbilityExecutionKind;
  /** Internal Abilities are callable only from Composite programs, never by the Agent. */
  readonly visibility?: "internal";
}

export interface AbilityAuthorDefinition<Name extends string, Input, Output>
  extends AbilityDefinition<Name, Input, Output> {
  readonly execution: BuiltInAbilityExecutionKind;
  execute(input: Input, context: AbilityInvocationContext): Promise<Output>;
}

export type ScopedAbilityNamespace<Definitions extends readonly unknown[]> = Readonly<{
  [Definition in Definitions[number] as Definition extends AbilityDefinition<infer Name, unknown, unknown>
    ? Name
    : never]: Definition extends AbilityDefinition<string, infer Input, infer Output>
      ? (input: Input) => Promise<Output>
      : never;
}>;

type AnyScopedAbilityNamespace = Readonly<Record<string, (input: never) => Promise<unknown>>>;

export interface CompositeProgramContext<Abilities extends AnyScopedAbilityNamespace> {
  readonly abilities: Abilities;
  readonly signal: AbortSignal;
}

export interface CompositeAbilityDefinition<
  Name extends string,
  Input,
  Output,
> extends AbilityDefinition<Name, Input, Output> {
  readonly execution: "composite";
  readonly compositeProgram: true;
  execute(input: Input, context: CompositeProgramContext<AnyScopedAbilityNamespace>): Promise<Output>;
}

export function defineAbility<
  const Name extends string,
  InputSchema extends ToolSchema<unknown>,
  OutputSchema extends ToolSchema<unknown>,
>(definition: Readonly<{
  name: Name;
  description: string;
  concurrency?: AbilityConcurrency;
  execution?: BuiltInAbilityExecutionKind;
  visibility?: "internal";
  input: InputSchema;
  output: OutputSchema;
  execute(
    input: InferToolSchema<InputSchema>,
    context: AbilityInvocationContext,
  ): Promise<InferToolSchema<OutputSchema>>;
}>): AbilityAuthorDefinition<Name, InferToolSchema<InputSchema>, InferToolSchema<OutputSchema>> {
  const contract = defineToolContract({
    name: definition.name,
    description: definition.description,
    input: definition.input,
    output: definition.output,
    render(_input, output) { return renderCanonicalAbilityOutput(output); },
  });
  return Object.freeze({
    ...contract,
    concurrency: definition.concurrency ?? "exclusive",
    execution: definition.execution ?? "query",
    ...(definition.visibility === undefined ? {} : { visibility: definition.visibility }),
    execute: definition.execute,
  }) as AbilityAuthorDefinition<
    Name,
    InferToolSchema<InputSchema>,
    InferToolSchema<OutputSchema>
  >;
}

export function defineCompositeAbility<
  Abilities extends AnyScopedAbilityNamespace,
>() {
  return function defineScopedCompositeAbility<
    const Name extends string,
    InputSchema extends ToolSchema<unknown>,
    OutputSchema extends ToolSchema<unknown>,
  >(definition: Readonly<{
    name: Name;
    description: string;
    concurrency?: AbilityConcurrency;
    input: InputSchema;
    output: OutputSchema;
    execute(
      input: InferToolSchema<InputSchema>,
      context: CompositeProgramContext<Abilities>,
    ): Promise<InferToolSchema<OutputSchema>>;
  }>): CompositeAbilityDefinition<Name, InferToolSchema<InputSchema>, InferToolSchema<OutputSchema>> {
    const contract = defineToolContract({
      name: definition.name,
      description: definition.description,
      input: definition.input,
      output: definition.output,
      render(_input, output) { return renderCanonicalAbilityOutput(output); },
    });
    return Object.freeze({
      ...contract,
      concurrency: definition.concurrency ?? "exclusive",
      execution: "composite",
      compositeProgram: true,
      execute: definition.execute,
    }) as CompositeAbilityDefinition<Name, InferToolSchema<InputSchema>, InferToolSchema<OutputSchema>>;
  };
}

export type AbilityRuntimeEvent = Readonly<Record<string, unknown> & { type: string }>;
export type ErasedAbility =
  | AbilityAuthorDefinition<string, unknown, unknown>
  | CompositeAbilityDefinition<string, unknown, unknown>;

export interface AbilityRuntimeOptions {
  readonly onEvent?: (event: AbilityRuntimeEvent) => void | Promise<void>;
  /** Test-only overrides; production callers use the fixed defaults. */
  readonly testingProgrammaticExecutionLimits?: Partial<ProgrammaticExecutionLimits>;
}

export interface ProgrammaticExecutionLimits {
  /** Worker CPU time. */
  readonly busyMs: number;
  /**
   * Wall-clock time spent while no body Ability, Composite or wait is in flight, which is when a
   * pause-when-idle World Run stands still. Time spent acting is bounded in game ticks instead.
   */
  readonly pausedMs: number;
  /** Game ticks one execution may let pass; ten minutes of game time by default. */
  readonly gameTicks: number;
  readonly maxOutputBytes: number;
  readonly maxOldGenerationSizeMb: number;
}

const DEFAULT_PROGRAMMATIC_EXECUTION_LIMITS: ProgrammaticExecutionLimits = Object.freeze({
  busyMs: 60_000,
  pausedMs: 300_000,
  gameTicks: 12_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxOldGenerationSizeMb: 512,
});

export interface ProgrammaticExecutionLog {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

/** Appended to a single log line that exceeds the remaining output byte budget. */
export const PROGRAMMATIC_OUTPUT_TRUNCATED_MARKER = "…[output truncated]";

const PROGRAMMATIC_OUTPUT_TRUNCATED_MARKER_BYTES = Buffer.byteLength(PROGRAMMATIC_OUTPUT_TRUNCATED_MARKER);

/** Bytes a truncated body may occupy so that body plus the marker stays within {@link maxBytes}. */
function truncationBodyBudget(maxBytes: number): number {
  return Math.max(0, maxBytes - PROGRAMMATIC_OUTPUT_TRUNCATED_MARKER_BYTES);
}

/** One line's share of the bounded output, tracked with its UTF-8 byte length. */
interface BoundedProgrammaticLine {
  readonly text: string;
  readonly bytes: number;
}

function omittedProgrammaticLinesNotice(omitted: number): BoundedProgrammaticLine {
  const text = `[run_code: ${omitted} earlier line(s) omitted due to output limit]\n`;
  return { text, bytes: Buffer.byteLength(text) };
}

/**
 * Bounds ordered model-visible log lines to {@link maxBytes}: every retained line ends with a
 * newline, a line exceeding the remaining budget is truncated at a UTF-8 boundary and marked
 * with {@link PROGRAMMATIC_OUTPUT_TRUNCATED_MARKER} instead, and total overflow drops the
 * oldest lines and prepends one omitted-notice line. The budget is a true bound: the
 * omitted notice is reserved as soon as overflow begins, and the per-stream truncation
 * notices are counted against the budget and prepended only while they fit, so the joined
 * lines never exceed {@link maxBytes}. Returns the lines plus how many earlier lines were
 * omitted.
 */
function boundProgrammaticLogLines(
  logs: readonly ProgrammaticExecutionLog[],
  maxBytes: number,
): Readonly<{ lines: readonly string[]; omitted: number }> {
  const notices = new Map<"stdout" | "stderr", number>();
  const lines: BoundedProgrammaticLine[] = [];
  let totalBytes = 0;
  let retained = 0;
  let headroom = 0;
  for (const log of logs) {
    const line = log.text.endsWith("\n") ? log.text : `${log.text}\n`;
    let text = line;
    if (Buffer.byteLength(line) > maxBytes) {
      const prefix = utf8Prefix(line, truncationBodyBudget(maxBytes))
        .replace(/\n$/u, "");
      text = `${prefix}${PROGRAMMATIC_OUTPUT_TRUNCATED_MARKER}\n`;
      notices.set(log.stream, (notices.get(log.stream) ?? 0) + 1);
    }
    const bytes = Buffer.byteLength(text);
    lines.push({ text, bytes });
    totalBytes += bytes;
    retained += 1;
    if (Buffer.byteLength(line) > maxBytes) continue;
    while (totalBytes + headroom > maxBytes && retained > 1) {
      const dropped = lines.shift();
      if (dropped === undefined) break;
      totalBytes -= dropped.bytes;
      retained -= 1;
      // Once lines must be dropped the omitted notice is guaranteed to be
      // emitted, so reserve its bytes within the same budget.
      headroom = omittedProgrammaticLinesNotice(logs.length - retained).bytes;
    }
  }
  let omitted = logs.length - retained;
  // The omitted notice is guaranteed once lines were dropped; the per-stream
  // truncation notices are prepended only while everything still fits. The
  // notice byte length grows with the omitted count, so the final notice can
  // exceed the headroom reserved mid-loop: keep dropping the oldest retained
  // line until the real notice plus the retained lines fit the budget, even if
  // that leaves the notice as the only model-visible line.
  const head: BoundedProgrammaticLine[] = [];
  if (omitted > 0) {
    let notice = omittedProgrammaticLinesNotice(omitted);
    while (totalBytes + notice.bytes > maxBytes) {
      const dropped = lines.shift();
      if (dropped === undefined) break;
      totalBytes -= dropped.bytes;
      retained -= 1;
      omitted = logs.length - retained;
      notice = omittedProgrammaticLinesNotice(omitted);
    }
    head.push(notice);
  }
  let headBytes = head.reduce((sum, line) => sum + line.bytes, 0);
  for (const stream of ["stdout", "stderr"] as const) {
    const truncations = notices.get(stream) ?? 0;
    if (truncations === 0) continue;
    const text = `[run_code: ${truncations} over-long ${stream} line(s) truncated]\n`;
    const bytes = Buffer.byteLength(text);
    if (headBytes + bytes + totalBytes > maxBytes) break;
    head.unshift({ text, bytes });
    headBytes += bytes;
  }
  return { lines: Object.freeze([...head, ...lines].map((line) => line.text)), omitted };
}

export interface ProgrammaticExecutionResult {
  readonly rootId: string;
  readonly executionId: string;
  readonly logs: readonly ProgrammaticExecutionLog[];
  readonly result?: unknown;
  readonly modelOutput: string;
}

export interface AbilityDispatchResult {
  readonly canonicalOutput: unknown;
  readonly modelContent: string;
}

export class AbilityRuntime {
  readonly #definitions = new RunAbilityCatalogue();
  readonly #eventListeners = new Set<(event: AbilityRuntimeEvent) => void | Promise<void>>();
  readonly #bodyGates = new WeakMap<object, AbilityBodyGate>();
  readonly #fallbackBodyScope = {};
  readonly #programmaticExecutionLimits: ProgrammaticExecutionLimits;

  public constructor(options: AbilityRuntimeOptions = {}) {
    if (options.onEvent !== undefined) this.#eventListeners.add(options.onEvent);
    this.#programmaticExecutionLimits = Object.freeze({
      ...DEFAULT_PROGRAMMATIC_EXECUTION_LIMITS,
      ...options.testingProgrammaticExecutionLimits,
    });
  }

  public get names(): readonly string[] {
    return this.#definitions.names;
  }

  public subscribeEvents(listener: (event: AbilityRuntimeEvent) => void | Promise<void>): () => void {
    this.#eventListeners.add(listener);
    return () => { this.#eventListeners.delete(listener); };
  }

  public async register(definition: ErasedAbility): Promise<void> {
    this.#definitions.register(definition);
  }

  public modelTools(): readonly AgentToolProjection[] {
    this.#definitions.freeze();
    return this.names.map((name) => projectToolContract(this.#definitions.get(name)!));
  }

  public typescriptSdk(): string {
    this.#definitions.freeze();
    const inputMembers = this.names.map((name) => {
      const definition = this.#definitions.get(name)!;
      const property = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ? name : JSON.stringify(name);
      return `  /** ${definition.description.replaceAll("*/", "* /")} */\n  readonly ${property}: ${renderToolSchemaTypeScript(definition.input)};`;
    });
    const outputMembers = this.names.map((name) => {
      const definition = this.#definitions.get(name)!;
      const property = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ? name : JSON.stringify(name);
      return `  readonly ${property}: ${abilitySdkOutputType(definition.output)};`;
    });
    return [
      "type CanonicalAbilitySuccess<Data> = { readonly ok: true; readonly message: string; readonly data: Data };",
      "type CanonicalAbilityFailure<Data> = { readonly ok: false; readonly error: \"RUNTIME_FAILED\" | \"INTERRUPTED\"; readonly message: string; readonly data: Data };",
      "type CanonicalAbilityResult<SuccessData, FailureData> = CanonicalAbilitySuccess<SuccessData> | CanonicalAbilityFailure<FailureData>;",
      "declare class ToolCallError extends Error {",
      "  readonly ability: string;",
      "}",
      `type AbilityInputMap = {\n${inputMembers.join("\n")}\n};`,
      `type AbilityOutputMap = {\n${outputMembers.join("\n")}\n};`,
      "declare const abilities: {",
      "  readonly [Name in keyof AbilityInputMap]: (input: AbilityInputMap[Name]) => Promise<AbilityOutputMap[Name]>;",
      "};",
    ].join("\n");
  }

  public async dispatch(name: string, input: unknown, context: AbilityExecutionContext = {}): Promise<unknown> {
    return (await this.dispatchTool(name, input, context)).canonicalOutput;
  }

  public async dispatchTool(
    name: string,
    input: unknown,
    context: AbilityExecutionContext = {},
  ): Promise<AbilityDispatchResult> {
    this.#definitions.freeze();
    if (this.#definitions.get(name)?.visibility === "internal") {
      throw new ToolCallError(name, `Ability ${name} is internal to Composite programs`);
    }
    const root = new AbilityRootExecution(context.signal);
    const executeRoot = async () => {
      let result: AbilityDispatchResult | undefined;
      let caught: unknown;
      let threw = false;
      try {
        result = await this.dispatchInRoot(name, input, context, root, [], undefined, name);
      } catch (error) {
        caught = error;
        threw = true;
      } finally {
        await root.drain();
      }
      if (root.failure !== undefined) throw root.failure;
      if (threw) throw caught;
      return result!;
    };
    return await executeRoot();
  }

  private async dispatchInRoot(
    name: string,
    input: unknown,
    context: AbilityExecutionContext,
    root: AbilityRootExecution,
    path: readonly string[],
    parentExecutionId: string | undefined,
    rootAbility: string,
    ownerScope?: CompositeProgramExecutionScope,
    parentDepth = 0,
  ): Promise<AbilityDispatchResult> {
    const initialDefinition = this.#definitions.get(name);
    if (initialDefinition === undefined) throw new ToolCallError(name, `Ability ${name} is not registered`);
    if (path.includes(name)) {
      throw new ToolCallError(name, `runtime Ability cycle: ${[...path, name].join(" -> ")}`);
    }
    root.recordDispatch();
    const executionId = root.nextExecutionId();
    const depth = parentDepth + 1;
    const nestedPath = [...path, name];
    let runtimeTrace: Readonly<Record<string, unknown>> | undefined;
    const executeCall = async (
      signal: AbortSignal,
      beforeCommit: () => Promise<void> = async () => {},
      definition: ErasedAbility = initialDefinition,
    ) => {
      let commitStarted = false;
      const beginCommit = async () => {
        if (commitStarted) return;
        commitStarted = true;
        await beforeCommit();
      };
      await this.emit({
        type: "ability_call_started",
        rootId: root.id,
        executionId,
        ...(parentExecutionId === undefined ? {} : { parentExecutionId }),
        ability: name,
        concurrency: definition.concurrency,
        execution: definition.execution,
        depth,
        dispatchCount: root.dispatchCount,
        input,
        source: context.invocationSource ?? "agent",
      });
      try {
        const runDefinition = async () => {
          const execution = await executeToolContract(definition, input, async (validatedInput) => {
            const execute = isCompositeAbilityDefinition(definition)
              ? async () => await this.executeCompositeProgram(
                  definition.name, this.#definitions.allNames, signal,
                  async (nestedName, nestedInput, scope) => (await this.dispatchInRoot(
                    nestedName, nestedInput, context, root, nestedPath, executionId,
                    rootAbility, scope, depth,
                  )).canonicalOutput,
                  async (programContext) => await definition.execute(validatedInput, programContext),
                  compositeExecutionTimeoutTicks(definition.name),
                  context.runtime,
                )
              : async () => await definition.execute(validatedInput, {
                  ...context,
                  signal,
                  execution: {
                    rootId: root.id,
                    executionId,
                    rootAbility,
                    ability: name,
                    depth,
                    dispatchCount: root.dispatchCount,
                  },
                  recordRuntimeTrace: (trace) => { runtimeTrace = trace; },
                });
            const output = await execute();
            await beginCommit();
            return output;
          });
          const validatedOutput = execution.canonicalOutput;
          throwIfActorUnavailable(validatedOutput, name);
          await this.emit({
            type: "ability_call_finished",
            rootId: root.id,
            executionId,
            ability: name,
            outcome: abilityCompletionOutcome(validatedOutput),
            result: validatedOutput,
            source: context.invocationSource ?? "agent",
            ...(runtimeTrace === undefined ? {} : { runtimeTrace }),
          });
          return Object.freeze({ canonicalOutput: validatedOutput, modelContent: execution.modelContent });
        };
        return initialDefinition.execution === "body"
          ? await this.bodyGate(context).run(signal, runDefinition)
          : await runDefinition();
      } catch (error) {
        if (error instanceof ActorUnavailableError) root.fail(error);
        await beginCommit();
        await this.emit({
          type: "ability_call_finished",
          rootId: root.id,
          executionId,
          ability: name,
          outcome: "error",
          message: errorMessage(error),
          source: context.invocationSource ?? "agent",
        });
        if (error instanceof ActorUnavailableError) throw error;
        if (error instanceof ToolCallError) throw error;
        if (error instanceof ToolContractError) throw new ToolCallError(name, errorMessage(error.cause ?? error));
        throw new ToolCallError(name, errorMessage(error));
      }
    };
    return initialDefinition.execution === "composite"
      ? await executeCall(ownerScope?.signal ?? root.signal)
      : await root.schedule(() => ({
          concurrency: initialDefinition.concurrency,
          run: async (signal: AbortSignal, beforeCommit: () => Promise<void>) => await executeCall(
            signal, beforeCommit,
          ),
        }), ownerScope?.signal);
  }

  private bodyGate(context: AbilityExecutionContext): AbilityBodyGate {
    const scope = context.runtime ?? this.#fallbackBodyScope;
    let gate = this.#bodyGates.get(scope);
    if (gate === undefined) {
      gate = new AbilityBodyGate();
      this.#bodyGates.set(scope, gate);
    }
    return gate;
  }

  private async executeCompositeProgram(
    name: string,
    visibleNames: readonly string[],
    signal: AbortSignal,
    invoke: (
      name: string,
      input: unknown,
      scope: CompositeProgramExecutionScope,
    ) => Promise<unknown>,
    execute: (context: CompositeProgramContext<AnyScopedAbilityNamespace>) => Promise<unknown>,
    executionTimeoutTicks?: number,
    runtime?: RuntimeAdapter,
  ): Promise<unknown> {
    const scope = new CompositeProgramExecutionScope(signal);
    // The deadline is game time, so a slow server does not shorten it.
    if (executionTimeoutTicks !== undefined) {
      void afterGameTicks(runtime, executionTimeoutTicks, scope.signal).then(() => {
        scope.abort(Object.assign(new Error(
          `Composite Program ${name} exceeded ${executionTimeoutTicks} game ticks`,
        ), { name: "CompositeExecutionTimeoutError" }));
      }, () => { /* the scope settled or the Runtime connection closed first */ });
    }
    const abilities = this.scopedAbilityNamespace(visibleNames, (name, childInput) => (
      scope.track(invoke(name, childInput, scope))
    ));
    let output: unknown;
    try {
      output = await execute({ abilities, signal: scope.signal });
    } finally {
      await scope.cancelAndDrain(new Error(`Composite Program ${name} settled`));
    }
    throwIfCompositeCancellationWasSwallowed(signal, output);
    return output;
  }

  private scopedAbilityNamespace(
    names: readonly string[],
    invoke: (name: string, input: unknown) => Promise<unknown>,
  ): AnyScopedAbilityNamespace {
    return Object.freeze(Object.fromEntries(names.map((name) => [
      name,
      (input: never) => invoke(name, input),
    ]))) as AnyScopedAbilityNamespace;
  }

  private async emit(event: AbilityRuntimeEvent): Promise<void> {
    await Promise.all([...this.#eventListeners].map(async (listener) => { await listener(event); }));
  }

  public async runCode(
    source: string,
    context: AbilityExecutionContext = {},
  ): Promise<ProgrammaticExecutionResult> {
    this.#definitions.freeze();
    const root = new AbilityRootExecution(context.signal);
    const executionId = root.nextExecutionId();
    const visibleAbilityNames = this.names;
    const logs: ProgrammaticExecutionLog[] = [];
    let worker: Worker | undefined;
    let termination: Promise<number> | undefined;
    const terminateWorker = async () => {
      const runningWorker = worker;
      if (runningWorker === undefined) return;
      termination ??= runningWorker.terminate();
      await termination;
      await Promise.allSettled([finished(runningWorker.stdout), finished(runningWorker.stderr)]);
    };
    let settled = false;
    let busyTimer: NodeJS.Timeout | undefined;
    // Wall-clock time counts only while the World Run stands still: no body Ability, Composite or wait in flight.
    let advancing = 0;
    let pausedMs = 0;
    let pausedSince = performance.now();
    let abortListener: (() => void) | undefined;
    let workerSignal: AbortSignal | undefined;
    try {
      await this.emit({
        type: "programmatic_execution_started",
        rootId: root.id,
        executionId,
        depth: 1,
        source: context.invocationSource ?? "agent",
      });
      let javascript: string;
      try {
        javascript = stripTypeScriptTypes(
          `async function __program(abilities: unknown) {\n${source}\n}`,
          { mode: "strip" },
        );
      } catch (error) {
        throw new ProgrammaticExecutionError(
          "typescript_not_erasable",
          `Programmatic Execution TypeScript is not erasable: ${errorMessage(error)}`,
          { cause: error },
        ).captureOutput(
          logs,
          root.id,
          executionId,
          this.#programmaticExecutionLimits.maxOutputBytes,
        );
      }
      const result = await this.executeCompositeProgram(
        "run_code",
        visibleAbilityNames,
        root.signal,
        async (name, input, scope) => {
          const definition = this.#definitions.get(name);
          const advances = definition !== undefined && (definition.execution !== "query" || name === "wait");
          if (advances && advancing++ === 0) pausedMs += performance.now() - pausedSince;
          try {
            return (await this.dispatchInRoot(name, input, context, root, [], executionId, "run_code", scope, 1)).canonicalOutput;
          } finally {
            if (advances && --advancing === 0) pausedSince = performance.now();
          }
        },
        async ({ abilities, signal }) => {
          workerSignal = signal;
          const runningWorker = worker = new Worker(workerSource(), {
            eval: true,
            env: {},
            execArgv: [],
            stdout: true,
            stderr: true,
            resourceLimits: {
              maxOldGenerationSizeMb: this.#programmaticExecutionLimits.maxOldGenerationSizeMb,
            },
            workerData: { source: javascript, abilityNames: Object.keys(abilities) },
          });
          return await new Promise<unknown>((resolve, reject) => {
            const fail = (error: ProgrammaticExecutionError) => {
              if (settled) return;
              settled = true;
              const captured = error.captureOutput(
                logs,
                root.id,
                executionId,
                this.#programmaticExecutionLimits.maxOutputBytes,
              );
              reject(captured);
            };
            // Output limiting is truncate-and-continue: an over-long line is truncated with
            // a visible marker and total overflow drops the oldest lines when the
            // model-visible output is rendered — the execution never fails on output volume.
            const capture = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
              const text = chunk.toString();
              if (text === "") return;
              logs.push({ stream, text });
            };
            runningWorker.stdout.on("data", (chunk: Buffer | string) => capture("stdout", chunk));
            runningWorker.stderr.on("data", (chunk: Buffer | string) => capture("stderr", chunk));
            const abort = () => {
              fail(new ProgrammaticExecutionError(
                "canceled",
                "Programmatic Execution canceled",
                { cause: signal.reason },
              ));
            };
            abortListener = abort;
            if (signal.aborted) return abort();
            signal.addEventListener("abort", abort, { once: true });
            const limits = this.#programmaticExecutionLimits;
            void afterGameTicks(context.runtime, limits.gameTicks, signal).then(() => {
              fail(new ProgrammaticExecutionError(
                "worker_tick_timeout",
                `Programmatic Execution exceeded ${limits.gameTicks} game ticks`,
              ));
            }, () => { /* the execution settled or the Runtime connection closed first */ });
            const busyPollMs = Math.max(
              5,
              Math.min(100, Math.floor(Math.min(limits.busyMs, limits.pausedMs) / 4)),
            );
            busyTimer = setInterval(() => {
              if (!settled && pausedMs + (advancing === 0 ? performance.now() - pausedSince : 0) > limits.pausedMs) {
                fail(new ProgrammaticExecutionError(
                  "worker_wall_timeout",
                  `Programmatic Execution spent more than ${limits.pausedMs} ms without acting or waiting`,
                ));
                return;
              }
              void runningWorker.cpuUsage().then((usage) => {
                if (settled) return;
                const busyMs = (usage.user + usage.system) / 1_000;
                if (busyMs <= this.#programmaticExecutionLimits.busyMs) return;
                fail(new ProgrammaticExecutionError(
                  "worker_busy_timeout",
                  `Programmatic Execution exceeded ${this.#programmaticExecutionLimits.busyMs} ms Worker busy time`,
                ));
              }).catch(() => undefined);
            }, busyPollMs);
            runningWorker.on("message", (message: unknown) => {
              if (settled) return;
              if (!isWorkerMessage(message)) {
                fail(new ProgrammaticExecutionError(
                  "rpc_protocol_error",
                  "Programmatic Execution Worker sent an invalid RPC message",
                ));
                return;
              }
              if (message.type === "call") {
                const scopedAbility = (
                  abilities as unknown as Readonly<Record<
                    string,
                    ((input: unknown) => Promise<unknown>) | undefined
                  >>
                )[message.name];
                const call = scopedAbility === undefined
                  ? Promise.reject(new ToolCallError(
                      message.name,
                      `Ability ${message.name} is not available to this Programmatic Execution`,
                    ))
                  : scopedAbility(message.input);
                void call.then(
                  (result) => runningWorker.postMessage({
                    type: "call_result", id: message.id, ok: true, result,
                  }),
                  (error) => runningWorker.postMessage({
                    type: "call_result", id: message.id, ok: false,
                    error: {
                      name: error instanceof ToolCallError ? "ToolCallError" : "Error",
                      message: errorMessage(error),
                      ...(error instanceof ToolCallError ? { ability: error.ability } : {}),
                    },
                  }),
                );
                return;
              }
              if (message.type === "log") {
                capture(message.stream, message.text);
                return;
              }
              if (message.type === "rpc_fault") {
                fail(new ProgrammaticExecutionError("rpc_protocol_error", message.message));
                return;
              }
              if (message.type === "complete") {
                try {
                  const result = message.result === undefined
                    ? undefined
                    : losslessJson(message.result, "run_code result");
                  const modelOutput = renderProgrammaticOutput(
                    source,
                    logs,
                    result,
                    this.#programmaticExecutionLimits.maxOutputBytes,
                  );
                  settled = true;
                  resolve({ result, modelOutput });
                }
                catch (error) {
                  fail(new ProgrammaticExecutionError(
                    "result_not_lossless_json",
                    errorMessage(error),
                    { cause: error },
                  ));
                }
              } else if (message.type === "failed") {
                fail(new ProgrammaticExecutionError(message.code, message.message));
              }
            });
            runningWorker.once("error", (error) => fail(new ProgrammaticExecutionError(
              "worker_crash",
              `Programmatic Execution Worker failed: ${errorMessage(error)}`,
              { cause: error },
            )));
            runningWorker.once("exit", (code) => {
              fail(new ProgrammaticExecutionError(
                "worker_crash",
                `Programmatic Execution Worker exited with code ${code}`,
              ));
            });
          });
        },
      );
      await root.drain();
      if (root.failure !== undefined) throw root.failure;
      await terminateWorker();
      const completion = result as Readonly<{ result?: unknown; modelOutput: string }>;
      const programmaticResult: ProgrammaticExecutionResult = {
        rootId: root.id,
        executionId,
        logs: logs.map((log) => ({ ...log })),
        ...(completion.result === undefined ? {} : { result: completion.result }),
        modelOutput: completion.modelOutput,
      };
      await this.emit({
        type: "programmatic_execution_finished",
        rootId: root.id,
        executionId,
        outcome: "succeeded",
        source: context.invocationSource ?? "agent",
      });
      return programmaticResult;
    } catch (error) {
      root.abort(error);
      await root.drain();
      await terminateWorker();
      const failure = root.failure ?? error;
      const correlated = failure instanceof ProgrammaticExecutionError
          && (failure.rootId === undefined || failure.executionId === undefined)
        ? failure.captureOutput(
            logs,
            root.id,
            executionId,
            this.#programmaticExecutionLimits.maxOutputBytes,
          )
        : failure;
      await this.emit({
        type: "programmatic_execution_finished",
        rootId: root.id,
        executionId,
        outcome: "error",
        message: errorMessage(correlated),
        source: context.invocationSource ?? "agent",
      });
      throw correlated;
    } finally {
      if (busyTimer !== undefined) clearInterval(busyTimer);
      if (abortListener !== undefined) workerSignal?.removeEventListener("abort", abortListener);

      await terminateWorker();
      root.abort(context.signal?.reason ?? new Error("Programmatic Execution ended"));
      await root.drain();
    }
  }
}


/** Game-tick deadlines read the Runtime clock; an execution context without one has no such deadline. */
function afterGameTicks(runtime: RuntimeAdapter | undefined, ticks: number, signal: AbortSignal): Promise<void> {
  return typeof runtime?.afterTicks === "function" ? runtime.afterTicks(ticks, signal) : new Promise(() => {});
}

function compositeExecutionTimeoutTicks(name: string): number | undefined {
  // Suffocation escape owns the only emergency execution deadline: 30 seconds of game time.
  // Keep this internal so ordinary Composite Ability contracts do not grow a generic
  // timeout surface; Ability Runtime still cancels and drains all children.
  return name === "suffocation_escape" ? 600 : undefined;
}

function throwIfActorUnavailable(output: unknown, ability: string): void {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return;
  const result = output as Readonly<Record<string, unknown>>;
  if (result.ok !== false || result.error !== "ACTOR_UNAVAILABLE") return;
  throw new ActorUnavailableError(
    typeof result.message === "string" && result.message.trim() !== ""
      ? result.message
      : `${ability} reported that the Actor incarnation is unavailable`,
  );
}

function isCompositeAbilityDefinition(
  definition: ErasedAbility,
): definition is CompositeAbilityDefinition<string, unknown, unknown> {
  return "compositeProgram" in definition && definition.compositeProgram === true;
}

function throwIfCompositeCancellationWasSwallowed(signal: AbortSignal, output: unknown): void {
  if (!signal.aborted || isInterruptedAbilityOutput(output)) return;
  throw signal.reason;
}

function isInterruptedAbilityOutput(output: unknown): boolean {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return false;
  const result = output as Readonly<Record<string, unknown>>;
  return result.ok === false && result.error === "INTERRUPTED";
}

function abilityCompletionOutcome(output: unknown): "succeeded" | "failed" {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return "succeeded";
  return (output as Readonly<Record<string, unknown>>).ok === false ? "failed" : "succeeded";
}

type WorkerMessage =
  | Readonly<{ type: "call"; id: number; name: string; input: unknown }>
  | Readonly<{ type: "log"; stream: "stdout" | "stderr"; text: string }>
  | Readonly<{ type: "complete"; result: unknown }>
  | Readonly<{ type: "rpc_fault"; message: string }>
  | Readonly<{
    type: "failed";
    code: "worker_runtime_error" | "result_not_lossless_json";
    message: string;
  }>;

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (value === null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "call") {
    if (!Number.isSafeInteger(message.id) || typeof message.name !== "string") return false;
    try { losslessJson(message.input, "Worker RPC input"); return true; }
    catch { return false; }
  }
  if (message.type === "log") {
    return (message.stream === "stdout" || message.stream === "stderr") && typeof message.text === "string";
  }
  if (message.type === "complete") return "result" in message;
  if (message.type === "rpc_fault") return typeof message.message === "string";
  return message.type === "failed"
    && (message.code === "worker_runtime_error" || message.code === "result_not_lossless_json")
    && typeof message.message === "string";
}

/**
 * The Worker runs the program in its own V8 context. That context holds JavaScript built-ins plus `abilities`,
 * `ToolCallError`, `console`, `setTimeout` and `clearTimeout`, and nothing of Node: no `process`, no `require`,
 * no `import()`. Only JSON text and numbers cross between the program and the Worker, so the program never holds
 * an object from which the Node side can be reached. A program can therefore act on the world only through its
 * Abilities.
 */
function workerSource(): string {
  return String.raw`
    const { parentPort, workerData } = require("node:worker_threads");
    const vm = require("node:vm");
    const { format } = require("node:util");

    // Evaluated inside the program context: everything the program can touch is created there.
    function bootstrap(bridge, abilityNamesJson) {
      class ToolCallError extends Error {
        constructor(ability, message) {
          super(message);
          this.name = "ToolCallError";
          this.ability = ability;
        }
      }
      function assertLosslessJson(value, path, ancestors = new Set()) {
        if (value === null || typeof value === "string" || typeof value === "boolean") return;
        if (typeof value === "number" && Number.isFinite(value)) return;
        if (typeof value !== "object") throw new Error(path + " is not lossless JSON");
        if (ancestors.has(value)) throw new Error(path + " contains a cycle and is not lossless JSON");
        ancestors.add(value);
        try {
          if (Array.isArray(value)) {
            value.forEach((entry, index) => assertLosslessJson(entry, path + "[" + index + "]", ancestors));
            return;
          }
          const prototype = Object.getPrototypeOf(value);
          if (prototype !== Object.prototype && prototype !== null) {
            throw new Error(path + " is not lossless JSON");
          }
          for (const [key, entry] of Object.entries(value)) {
            assertLosslessJson(entry, path + "." + key, ancestors);
          }
        } finally {
          ancestors.delete(value);
        }
      }
      const send = (message) => bridge.post(JSON.stringify(message));
      let nextId = 0;
      const pending = new Map();
      const abilities = Object.fromEntries(JSON.parse(abilityNamesJson).map((name) => [name, (input = {}) => {
        try {
          assertLosslessJson(input, name + " input");
        } catch (error) {
          send({ type: "rpc_fault", message: error.message });
          return Promise.reject(error);
        }
        return new Promise((resolve, reject) => {
          const id = ++nextId;
          pending.set(id, { resolve, reject });
          send({ type: "call", id, name, input });
        });
      }]));
      let nextTimer = 0;
      const timers = new Map();
      const print = (stream) => (...values) => bridge.log(stream, values);
      globalThis.ToolCallError = ToolCallError;
      globalThis.console = Object.freeze({
        log: print("stdout"), info: print("stdout"), debug: print("stdout"),
        warn: print("stderr"), error: print("stderr"),
      });
      globalThis.setTimeout = (callback, delay, ...values) => {
        const id = ++nextTimer;
        timers.set(id, () => callback(...values));
        bridge.timer(id, Number(delay) || 0);
        return id;
      };
      globalThis.clearTimeout = (id) => { timers.delete(id); };
      return {
        settle(json) {
          const message = JSON.parse(json);
          const entry = pending.get(message.id);
          if (entry === undefined) return;
          pending.delete(message.id);
          if (message.ok) entry.resolve(message.result);
          else {
            entry.reject(message.error.name === "ToolCallError"
              ? new ToolCallError(message.error.ability, message.error.message)
              : new Error(message.error.message));
          }
        },
        fire(id) {
          const callback = timers.get(id);
          timers.delete(id);
          if (callback !== undefined) callback();
        },
        run(program) { return program(abilities); },
        encode(result) {
          if (result === undefined) return undefined;
          assertLosslessJson(result, "run_code result");
          return JSON.stringify(result);
        },
      };
    }

    function messageOf(error) {
      try {
        return error !== null && typeof error === "object" && typeof error.message === "string"
          ? error.message : String(error);
      } catch {
        return "program failed with a value that cannot be described";
      }
    }
    const context = vm.createContext(Object.create(null));
    let hooks;
    // The three ways out of the program context. None returns a value or throws into it.
    const bridge = Object.freeze({
      post(json) { try { parentPort.postMessage(JSON.parse(json)); } catch {} },
      log(stream, values) {
        try { parentPort.postMessage({ type: "log", stream, text: format(...values) + "\n" }); } catch {}
      },
      timer(id, delay) { setTimeout(() => { try { hooks.fire(id); } catch {} }, delay); },
    });
    hooks = vm.runInContext("(" + bootstrap.toString() + ")", context)(
      bridge, JSON.stringify(workerData.abilityNames));
    parentPort.on("message", (message) => {
      if (message.type === "call_result") hooks.settle(JSON.stringify(message));
    });
    (async () => {
      try {
        const program = vm.runInContext(
          "(() => {" + workerData.source + "\n; return __program; })()", context, { filename: "run_code" });
        const result = await hooks.run(program);
        let encoded;
        try {
          encoded = hooks.encode(result);
        } catch (error) {
          parentPort.postMessage({ type: "failed", code: "result_not_lossless_json", message: messageOf(error) });
          return;
        }
        parentPort.postMessage({ type: "complete", result: encoded === undefined ? undefined : JSON.parse(encoded) });
      } catch (error) {
        parentPort.postMessage({ type: "failed", code: "worker_runtime_error", message: messageOf(error) });
      }
    })();
  `;
}

function losslessJson(value: unknown, path: string, ancestors: Set<object> = new Set()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object") {
    if (ancestors.has(value)) throw new Error(`${path} contains a cycle and is not lossless JSON`);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((entry, index) => losslessJson(entry, `${path}[${index}]`, ancestors));
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} is not lossless JSON`);
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key, losslessJson(entry, `${path}.${key}`, ancestors),
      ]));
    } finally {
      ancestors.delete(value);
    }
  }
  throw new Error(`${path} is not lossless JSON`);
}

function renderCanonicalAbilityOutput(output: unknown): string {
  const rendered = JSON.stringify(output);
  if (typeof rendered !== "string") throw new Error("Canonical Ability Result could not be rendered as JSON");
  return rendered;
}

/**
 * Renders the model-visible success output: bounded log lines plus the rendered returned
 * value, which shares the same output budget and is truncated at a UTF-8 boundary with a
 * visible marker instead of failing the execution. The final output — marker included —
 * never exceeds {@link maxOutputBytes}: the bounded log lines already fit it, so the
 * truncation point never cuts into them unless nothing else fits.
 */
function renderProgrammaticOutput(
  source: string,
  logs: readonly ProgrammaticExecutionLog[],
  result: unknown,
  maxOutputBytes: number,
): string {
  const bounded = boundProgrammaticLogLines(logs, maxOutputBytes);
  const rendered = programmaticCodeContract.tool.render(
    { description: "Execute the submitted Programmatic Execution", code: source },
    {
      logs: [...bounded.lines],
      ...(result === undefined ? {} : { result }),
    },
  );
  if (Buffer.byteLength(rendered) <= maxOutputBytes) return rendered;
  const logsBytes = Buffer.byteLength(bounded.lines.join(""));
  const markerBytes = PROGRAMMATIC_OUTPUT_TRUNCATED_MARKER_BYTES;
  // The final output — marker included — never exceeds maxOutputBytes, and the
  // truncation point never cuts into the bounded log lines: when the logs fill
  // the budget by themselves they are already the complete model-visible output
  // (the returned value has no room to render), so they stand without a marker.
  // With an undefined result the render is exactly the logs, so over-budget
  // output here always owes to an oversized returned value.
  if (result === undefined) return bounded.lines.join("");
  if (logsBytes >= maxOutputBytes) return bounded.lines.join("");
  // Truncate the whole render at the body budget. Because the bounded log lines
  // come first in the render and always fit the body budget here (the early
  // return above covers logs that fill the budget by themselves), the cut only
  // ever lands in the returned-value render — never inside a retained log line.
  return utf8Prefix(rendered, truncationBodyBudget(maxOutputBytes)) + PROGRAMMATIC_OUTPUT_TRUNCATED_MARKER;
}

function renderProgrammaticFailure(error: ProgrammaticExecutionError, maxOutputBytes: number): string {
  const bounded = boundProgrammaticLogLines(error.logs, maxOutputBytes);
  const printed = bounded.lines.join("");
  const failure = `Programmatic Execution failed (${error.code}): ${error.message}`;
  const rendered = printed === "" ? failure : `${failure}\nCaptured output:\n${printed}`;
  return utf8Prefix(rendered, maxOutputBytes);
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let bytes = 0;
  let prefix = "";
  for (const character of value) {
    const width = Buffer.byteLength(character);
    if (bytes + width > maxBytes) break;
    prefix += character;
    bytes += width;
  }
  return prefix;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
