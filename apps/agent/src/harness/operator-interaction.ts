import type { AgentToolProjection } from "./model-surface-message.js";

export interface OperatorTurn {
  readonly observation: string;
  readonly previousResult?: string;
  readonly tools: readonly AgentToolProjection[];
}

export interface OperatorSelection {
  readonly toolName: string;
  readonly input: unknown;
}

/** Selects one registered Ability directly from a fresh Harness Turn Observation. */
export interface OperatorInteraction {
  choose(turn: OperatorTurn, options: Readonly<{ signal?: AbortSignal }>): Promise<OperatorSelection>;
  close?(): void;
}
