import { describe, expect, it, vi } from "vitest";
import type { RuntimeBodyState } from "@evicraft/runtime-sdk";
import { HazardDecisionController } from "../src/harness/hazard-decision-controller.js";
const body = (overrides: Partial<RuntimeBodyState> = {}): RuntimeBodyState => ({ health: 20, max_health: 20,
  air: 300, max_air: 300, underwater: false, in_lava: false, on_fire: false, suffocating: false, intersecting_blocks: [], ...overrides });
function controller() {
  const onYield = vi.fn(), onTrace = vi.fn();
  const instance = new HazardDecisionController({ onYield, onTrace });
  const emit = (sequence: number, overrides: Partial<RuntimeBodyState>) => instance.handleOccurrence({
    type: "body_state_changed", sequence, server_tick: sequence, data: body(overrides) });
  return { instance, emit, onYield, onTrace };
}
describe("Hazard decision episodes", () => {
  it("coalesces simultaneous hazards, lets the response run, and rearms only after clearing", () => {
    const { instance, emit, onYield } = controller();
    emit(1, { underwater: true, air: 100, on_fire: true });
    expect(instance.takeReasons()).toEqual(["low_air", "on_fire"]);
    emit(2, { underwater: true, air: 80, on_fire: true });
    expect(instance.takeReasons()).toEqual([]);
    expect(onYield).toHaveBeenCalledTimes(1);
    emit(3, { underwater: true, air: 70, on_fire: true, suffocating: true });
    expect(instance.takeReasons()).toEqual(["suffocation"]);
    emit(4, {});
    emit(5, { underwater: true, air: 100 });
    expect(instance.takeReasons()).toEqual(["low_air"]);
    expect(onYield).toHaveBeenCalledTimes(3);
  });
  it("keeps the initial observation in the first decision and ignores old pushed states", () => {
    const { instance, emit, onYield } = controller();
    instance.seed(body({ suffocating: true }));
    expect(instance.takeReasons()).toEqual(["suffocation"]);
    expect(onYield).not.toHaveBeenCalled();
    emit(10, {});
    emit(9, { suffocating: true });
    expect(instance.takeReasons()).toEqual([]);
    emit(11, { suffocating: true });
    expect(instance.takeReasons()).toEqual(["suffocation"]);
  });
  it.each([
    [{ health: 5 }, ["low_health"]], [{ health: 5.1 }, []], [{ health: 0 }, []],
    [{ health: 10, max_health: 40 }, ["low_health"]], [{ in_lava: true }, ["in_lava"]],
    [{ underwater: true, air: 101 }, []], [{ air: 0 }, []],
  ] as const)("uses the declared living-body thresholds %j", (state, expected) => {
    const { instance, emit } = controller(); emit(1, state); expect(instance.takeReasons()).toEqual(expected);
  });
  it("snapshots reasons at interruption without leaking later hazards into them", () => {
    const { instance, emit, onYield, onTrace } = controller();
    emit(1, { underwater: true, air: 80 });
    expect(instance.takeInterruptionReasons()).toEqual(["low_air"]);
    expect(instance.takeInterruptionReasons()).toEqual([]);
    expect(onYield).toHaveBeenCalledTimes(1);
    expect(onTrace).toHaveBeenCalledWith({ type: "hazard_interruption", reasons: ["low_air"] });
    emit(2, { underwater: true, air: 80, on_fire: true });
    emit(3, { underwater: true, air: 80, on_fire: true, suffocating: true });
    expect(instance.takeReasons()).toEqual(["suffocation", "on_fire"]);
  });
  it("keeps reasons pending when an interruption snapshot finds nothing to absorb", () => {
    const { instance, emit, onTrace } = controller();
    // The interrupting hazard arrived after the abort: the empty snapshot
    // consumes nothing, and the reason still reaches the trigger field.
    expect(instance.takeInterruptionReasons()).toEqual([]);
    emit(1, { on_fire: true });
    expect(instance.takeReasons()).toEqual(["on_fire"]);
    expect(onTrace).not.toHaveBeenCalledWith(expect.objectContaining({ type: "hazard_interruption" }));
  });
  it("does not accumulate or yield disabled hazards", () => {
    const { instance, emit, onYield } = controller(); instance.stop();
    instance.seed(body({ on_fire: true })); emit(1, { in_lava: true });
    expect(instance.takeReasons()).toEqual([]); expect(onYield).not.toHaveBeenCalled();
  });
});
