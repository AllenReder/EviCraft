export const harnessControlToolNames = Object.freeze({
  runCode: "run_code",
  loadSkill: "load_skill",
  updatePlan: "update_plan",
  captureView: "capture_view",
});

// Reject stale Ability definitions using the retired model-facing name.
const reservedControlToolNames = new Set<string>([...Object.values(harnessControlToolNames), "end_run"]);

export function isHarnessControlToolName(name: string): boolean {
  return reservedControlToolNames.has(name);
}
