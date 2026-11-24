import type { RuntimeBodyState, RuntimeOccurrence } from "@evicraft/runtime-sdk";

export const HAZARD_DECISION_POLICY = Object.freeze({
  version: "1", lowAirTicks: 100, lowHealthFraction: 0.25,
  kinds: ["suffocation", "low_air", "on_fire", "in_lava", "low_health"] as const,
});
export type HazardKind = typeof HAZARD_DECISION_POLICY.kinds[number];

/** Latches hazard episodes and requests model attention; never executes an Ability. */
export class HazardDecisionController {
  readonly #active = new Set<HazardKind>();
  readonly #pending = new Set<HazardKind>();
  #seeded = false;
  #stopped = false;
  #lastSequence = -1;

  constructor(private readonly options: Readonly<{
    onYield: (reasons: readonly HazardKind[]) => void;
    onTrace: (event: Readonly<Record<string, unknown> & { type: string }>) => void;
  }>) {}

  /** The existing first observation supplies initial conditions without another query or discarded turn. */
  seed(body: RuntimeBodyState): void {
    if (this.#seeded || this.#lastSequence >= 0) return;
    this.#seeded = true;
    this.observe(body, false);
  }

  handleOccurrence(occurrence: RuntimeOccurrence): void {
    if (this.#stopped || occurrence.type !== "body_state_changed" || occurrence.sequence <= this.#lastSequence) return;
    this.#lastSequence = occurrence.sequence;
    this.observe(occurrence.data, true);
  }

  /**
   * Consumes the pending reasons into the trigger field of the next Decision
   * Context. Together with the interruption snapshot this is one of exactly
   * two delivery points: the reasons leave `#pending` exactly once, so they
   * are never silently cleared by a later action dispatch and never reappear
   * after a committed INTERRUPTED result already carried them.
   */
  takeReasons(): readonly HazardKind[] {
    return this.#drain("hazard_response_started");
  }

  /**
   * Consumes the abort-time snapshot into the INTERRUPTED-result synthesis.
   * When nothing is pending the interrupting hazard arrived after the abort
   * (between cycles or during the action-end pause); its reasons stay pending
   * for the trigger field instead of being silently drained here.
   */
  takeInterruptionReasons(): readonly HazardKind[] {
    if (!HAZARD_DECISION_POLICY.kinds.some(kind => this.#pending.has(kind))) return [];
    return this.#drain("hazard_interruption");
  }

  #drain(traceType: string): readonly HazardKind[] {
    const reasons = HAZARD_DECISION_POLICY.kinds.filter(kind => this.#pending.has(kind));
    this.#pending.clear();
    if (reasons.length) this.options.onTrace({ type: traceType, reasons });
    return reasons;
  }

  stop(): void { this.#stopped = true; this.#pending.clear(); }

  private observe(body: RuntimeBodyState, interrupt: boolean): void {
    if (this.#stopped) return;
    const current: Record<HazardKind, boolean> = {
      suffocation: body.suffocating,
      low_air: body.underwater && body.air <= HAZARD_DECISION_POLICY.lowAirTicks,
      on_fire: body.on_fire,
      in_lava: body.in_lava,
      low_health: body.health > 0 && body.health <= body.max_health * HAZARD_DECISION_POLICY.lowHealthFraction,
    };
    const entered: HazardKind[] = [];
    for (const kind of HAZARD_DECISION_POLICY.kinds) {
      if (!current[kind]) {
        if (this.#active.delete(kind)) this.options.onTrace({ type: "hazard_cleared", kind });
      } else if (!this.#active.has(kind)) {
        this.#active.add(kind);
        this.#pending.add(kind);
        entered.push(kind);
      }
    }
    if (entered.length) {
      this.options.onTrace({ type: "hazard_detected", reasons: entered, initial: !interrupt, body });
      if (interrupt) this.options.onYield(entered);
    }
  }
}
