import { withoutImages, type ModelAssistantMessage, type ModelMessage } from "./model-surface-message.js";

/** Images older than the retained window are replaced by this text in model requests. */
export const OMITTED_IMAGE_TEXT = "[Earlier capture_view image omitted from context.]";

interface DecisionContextMessages {
  readonly message: ModelMessage;
  readonly historyMessage: ModelMessage;
}

export interface CompletedToolCycle {
  readonly decisionContext: ModelMessage;
  readonly assistant: ModelAssistantMessage;
  readonly toolResult: ModelMessage;
  /** User message that follows the tool result, carrying an image the tool produced. */
  readonly attachment?: ModelMessage;
}

/** A run-local, structured record of the model-visible current context and completed Tool Cycles. */
export class ModelSurface {
  readonly #operatingContract: ModelMessage;
  #currentContext: DecisionContextMessages;
  #historySummary: ModelMessage | undefined;
  #completedCycles: CompletedToolCycle[] = [];

  readonly #retainedImages: number;

  /** `retainedImages` keeps that many most recent attachments with their images in requests; 0 without vision. */
  public constructor(operatingContract: ModelMessage, initialContext: DecisionContextMessages, retainedImages = 0) {
    this.#operatingContract = operatingContract;
    this.#currentContext = initialContext;
    this.#retainedImages = retainedImages;
  }

  public get historySummary(): ModelMessage | undefined {
    return this.#historySummary;
  }

  public get currentContext(): ModelMessage {
    return this.#currentContext.message;
  }

  public replaceCurrentContext(context: DecisionContextMessages): void {
    this.#currentContext = context;
  }

  /** Project the structured surface without inferring cycles from message positions. */
  public requestMessages(): readonly ModelMessage[] {
    return this.previewHistory(this.#historySummary, this.#completedCycles);
  }

  /** Inspect a candidate replacement without changing the accepted history. */
  public previewHistory(summary: ModelMessage | undefined, cycles: readonly CompletedToolCycle[]): readonly ModelMessage[] {
    let imagesLeft = this.#retainedImages;
    const attachments = new Map<CompletedToolCycle, ModelMessage>();
    for (let index = cycles.length - 1; index >= 0; index--) {
      const cycle = cycles[index]!;
      if (cycle.attachment === undefined) continue;
      attachments.set(cycle, imagesLeft > 0 ? cycle.attachment : withoutImages(cycle.attachment, OMITTED_IMAGE_TEXT));
      imagesLeft--;
    }
    return [
      this.#operatingContract,
      ...(summary === undefined ? [] : [summary]),
      ...cycles.flatMap(cycle => {
        const attachment = attachments.get(cycle);
        return [cycle.decisionContext, cycle.assistant, cycle.toolResult, ...(attachment === undefined ? [] : [attachment])];
      }),
      this.#currentContext.message,
    ];
  }

  public get completedCycles(): readonly CompletedToolCycle[] {
    return this.#completedCycles;
  }

  /** Retain model history and return the complete cycle for the audit journal. */
  public commit(
    assistant: ModelAssistantMessage,
    toolResult: ModelMessage,
    attachment?: Readonly<{ message: ModelMessage; journalPlaceholder: string }>,
  ): Readonly<{ decisionContext: ModelMessage; assistant: ModelAssistantMessage; toolResult: ModelMessage; attachment?: ModelMessage }> {
    // Requests and compaction share observation-free history; the journal receives the full context.
    this.#completedCycles.push({ decisionContext: this.#currentContext.historyMessage, assistant, toolResult,
      ...(attachment === undefined ? {} : { attachment: attachment.message }) });
    // Images are stored as files; the journal names the file instead of repeating the encoded bytes.
    return { decisionContext: this.#currentContext.message, assistant, toolResult,
      ...(attachment === undefined ? {} : { attachment: withoutImages(attachment.message, attachment.journalPlaceholder) }) };
  }

  public replaceHistory(summary: ModelMessage | undefined, cycles: readonly CompletedToolCycle[]): number {
    const removed = this.#completedCycles.length - cycles.length;
    this.#historySummary = summary;
    this.#completedCycles = [...cycles];
    return removed;
  }
}
