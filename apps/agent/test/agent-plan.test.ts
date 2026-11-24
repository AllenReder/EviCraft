import { describe, expect, it } from "vitest";

import {
  AgentPlanState,
  InvalidAgentPlanError,
  type AgentPlanItem,
  type AgentPlanItemStatus,
} from "../src/harness/agent-plan.js";

describe("Agent Plan", () => {
  it("starts every state with an independent empty revision-zero projection", () => {
    const first = new AgentPlanState();
    const second = new AgentPlanState();

    expect(first.snapshot()).toEqual({ revision: 0, items: [] });
    expect(second.snapshot()).toEqual({ revision: 0, items: [] });
    expect(first.snapshot()).not.toBe(first.snapshot());
    expect(first.snapshot().items).not.toBe(second.snapshot().items);
  });

  it("atomically replaces the complete snapshot and increments only successful revisions", () => {
    const plan = new AgentPlanState();
    const submitted = [
      item("inspect", "Inspect the current inventory", "completed"),
      item("craft", "Craft the required tool", "in_progress"),
      item("equip", "Equip the crafted tool", "pending"),
    ];

    expect(plan.replace(submitted)).toEqual({ revision: 1, items: submitted });
    submitted[1] = item("changed", "Mutated caller input", "cancelled");
    expect(plan.snapshot()).toEqual({
      revision: 1,
      items: [
        item("inspect", "Inspect the current inventory", "completed"),
        item("craft", "Craft the required tool", "in_progress"),
        item("equip", "Equip the crafted tool", "pending"),
      ],
    });

    expect(() => plan.replace([
      item("duplicate", "First", "in_progress"),
      item("duplicate", "Second", "pending"),
    ])).toThrowError(InvalidAgentPlanError);
    expect(plan.snapshot().revision).toBe(1);

    expect(plan.replace([item("done", "All work is terminal", "completed")]))
      .toEqual({ revision: 2, items: [item("done", "All work is terminal", "completed")] });
  });

  it.each([
    { label: "non-array items", items: {} },
    { label: "non-object item", items: [null] },
    { label: "array item", items: [[]] },
    { label: "missing field", items: [{ id: "missing", status: "in_progress" }] },
    { label: "extra field", items: [{ id: "extra", content: "Extra", status: "in_progress", note: "x" }] },
    { label: "non-string id", items: [{ id: 1, content: "Numeric id", status: "in_progress" }] },
    { label: "non-string content", items: [{ id: "content", content: 1, status: "in_progress" }] },
    { label: "duplicate ids", items: [item("same", "First", "in_progress"), item("same", "Second", "pending")] },
    { label: "empty content", items: [item("empty", "", "in_progress")] },
    { label: "whitespace-only content", items: [item("blank", "   ", "in_progress")] },
    { label: "unsupported status", items: [{ id: "bad", content: "Bad status", status: "blocked" }] },
  ])("rejects $label without publishing a partial snapshot", ({ items }) => {
    const plan = new AgentPlanState();
    expect(() => plan.replace(items as unknown as readonly AgentPlanItem[])).toThrowError(InvalidAgentPlanError);
    expect(plan.snapshot()).toEqual({ revision: 0, items: [] });
  });

  it.each(statusCases())("accepts exactly the valid unfinished-focus invariant: $label", ({ statuses, valid }) => {
    const plan = new AgentPlanState();
    const items = statuses.map((status, index) => item(`item-${index}`, `Step ${index}`, status));

    if (valid) {
      expect(plan.replace(items)).toEqual({ revision: 1, items });
    } else {
      expect(() => plan.replace(items)).toThrowError(InvalidAgentPlanError);
      expect(plan.snapshot()).toEqual({ revision: 0, items: [] });
    }
  });

});

function item(id: string, content: string, status: AgentPlanItemStatus): AgentPlanItem {
  return { id, content, status };
}

function statusCases(): ReadonlyArray<Readonly<{
  label: string;
  statuses: readonly AgentPlanItemStatus[];
  valid: boolean;
}>> {
  const statuses: readonly AgentPlanItemStatus[] = ["pending", "in_progress", "completed", "cancelled"];
  const cases: Array<Readonly<{ label: string; statuses: readonly AgentPlanItemStatus[]; valid: boolean }>> = [];
  for (let length = 0; length <= 3; length += 1) {
    for (const candidate of products(statuses, length)) {
      const unfinished = candidate.filter((status) => status === "pending" || status === "in_progress").length;
      const inProgress = candidate.filter((status) => status === "in_progress").length;
      cases.push({
        label: candidate.length === 0 ? "empty" : candidate.join(","),
        statuses: candidate,
        valid: unfinished === 0 ? inProgress === 0 : inProgress === 1,
      });
    }
  }
  return cases;
}

function products<T>(values: readonly T[], length: number): readonly (readonly T[])[] {
  if (length === 0) return [[]];
  return products(values, length - 1).flatMap((prefix) => values.map((value) => [...prefix, value]));
}
