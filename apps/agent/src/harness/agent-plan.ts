export type AgentPlanItemStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface AgentPlanItem {
  readonly id: string;
  readonly content: string;
  readonly status: AgentPlanItemStatus;
}

export interface AgentPlanProjection {
  readonly revision: number;
  readonly items: readonly AgentPlanItem[];
}

export class InvalidAgentPlanError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidAgentPlanError";
  }
}

/** Run-local typed source of truth for the Agent's explicit working plan. */
export class AgentPlanState {
  private revision = 0;
  private items: readonly AgentPlanItem[] = Object.freeze([]);

  public snapshot(): AgentPlanProjection {
    return Object.freeze({
      revision: this.revision,
      items: copyItems(this.items),
    });
  }

  public replace(items: readonly AgentPlanItem[]): AgentPlanProjection {
    const canonicalItems = validateAgentPlanItems(items);
    this.items = canonicalItems;
    this.revision += 1;
    return this.snapshot();
  }
}

export function validateAgentPlanItems(value: unknown): readonly AgentPlanItem[] {
  if (!Array.isArray(value)) throw new InvalidAgentPlanError("Agent Plan items must be an array");

  const ids = new Set<string>();
  const canonicalItems: AgentPlanItem[] = [];
  let unfinishedCount = 0;
  let inProgressCount = 0;
  for (const [index, item] of value.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new InvalidAgentPlanError(`Agent Plan item ${index} must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (Object.keys(record).length !== 3
      || !Object.hasOwn(record, "id")
      || !Object.hasOwn(record, "content")
      || !Object.hasOwn(record, "status")) {
      throw new InvalidAgentPlanError(`Agent Plan item ${index} must contain only id, content, and status`);
    }
    if (typeof record.id !== "string") {
      throw new InvalidAgentPlanError(`Agent Plan item ${index} id must be a string`);
    }
    if (ids.has(record.id)) throw new InvalidAgentPlanError(`Agent Plan item id must be unique: ${record.id}`);
    if (typeof record.content !== "string" || record.content.trim().length === 0) {
      throw new InvalidAgentPlanError(`Agent Plan item ${index} content must be non-empty`);
    }
    if (!isAgentPlanItemStatus(record.status)) {
      throw new InvalidAgentPlanError(
        `Agent Plan item ${index} status must be pending, in_progress, completed, or cancelled`,
      );
    }

    ids.add(record.id);
    if (record.status === "pending" || record.status === "in_progress") unfinishedCount += 1;
    if (record.status === "in_progress") inProgressCount += 1;
    canonicalItems.push(Object.freeze({ id: record.id, content: record.content, status: record.status }));
  }

  if (unfinishedCount > 0 && inProgressCount !== 1) {
    throw new InvalidAgentPlanError("an unfinished Agent Plan must contain exactly one in_progress item");
  }
  return Object.freeze(canonicalItems);
}

function isAgentPlanItemStatus(value: unknown): value is AgentPlanItemStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function copyItems(items: readonly AgentPlanItem[]): readonly AgentPlanItem[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}
