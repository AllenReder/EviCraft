import { describe, expect, it, vi } from "vitest";

import { loadSkillControl, updatePlanControl } from "../src/harness/control-tools.js";
import {
  ToolContractError,
  defineToolContract,
  executeToolContract,
  projectToolContract,
} from "../src/harness/tool-contract.js";
import { toolSchema as s } from "../src/harness/tool-schema.js";

describe("Tool Contract public execution seam", () => {
  it("validates and snapshots canonical output before pure rendering", async () => {
    const contract = defineToolContract({
      name: "example",
      description: "Execute one example operation.",
      input: s.object({
        value: s.field(s.integer(), { description: "Input safe integer." }),
      }),
      output: s.object({
        doubled: s.field(s.integer(), { description: "Verified doubled value." }),
      }),
      render(input, output) {
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(output)).toBe(true);
        return `${input.value} -> ${output.doubled}`;
      },
    });
    const produced = { doubled: 6 };

    const execution = await executeToolContract(contract, { value: 3 }, async () => produced);
    produced.doubled = 99;

    expect(execution).toEqual({
      input: { value: 3 },
      canonicalOutput: { doubled: 6 },
      modelContent: "3 -> 6",
    });
  });

  it("projects only provider-supported input fields", () => {
    for (const contract of [loadSkillControl, updatePlanControl]) {
      expect(projectToolContract(contract)).toEqual({
        name: contract.name,
        description: contract.description,
        inputSchema: contract.input.jsonSchema,
        strict: false,
      });
    }
  });

  it("validates and renders Project Skill and Agent Plan canonical outputs", async () => {
    const loaded = await executeToolContract(
      loadSkillControl,
      { name: "containers" },
      async () => ({
        ok: true,
        message: "loaded project Skill content",
        data: {
          name: "containers",
          file: "SKILL.md",
          digest: "abc123",
          content: "Use exact container evidence.",
        },
      }),
    );
    expect(loaded.canonicalOutput).toEqual({
      ok: true,
      message: "loaded project Skill content",
      data: {
        name: "containers",
        file: "SKILL.md",
        digest: "abc123",
        content: "Use exact container evidence.",
      },
    });
    expect(loaded.modelContent).toBe(JSON.stringify(loaded.canonicalOutput));

    const updated = await executeToolContract(
      updatePlanControl,
      { items: [{ id: "mine", content: "Mine three iron ore", status: "in_progress" }] },
      async (input) => ({ revision: 1, items: input.items }),
    );
    expect(updated.canonicalOutput).toEqual({
      revision: 1,
      items: [{ id: "mine", content: "Mine three iron ore", status: "in_progress" }],
    });
    expect(updated.modelContent).toBe(JSON.stringify(updated.canonicalOutput));
  });

  it("turns malformed output and renderer failure into contract errors", async () => {
    const render = vi.fn(() => "rendered");
    const contract = defineToolContract({
      name: "example",
      description: "Execute one example operation.",
      input: s.object({}),
      output: s.object({
        ended: s.field(s.literal(true), { description: "Whether execution ended." }),
      }),
      render,
    });

    await expect(executeToolContract(contract, {}, async () => ({ ended: false as true })))
      .rejects.toMatchObject({
        name: "ToolContractError",
        tool: "example",
        stage: "output_validation",
      });
    expect(render).not.toHaveBeenCalled();

    const brokenRenderer = defineToolContract({
      ...contract,
      render() { throw new Error("presentation failed"); },
    });
    await expect(executeToolContract(brokenRenderer, {}, async () => ({ ended: true })))
      .rejects.toEqual(expect.objectContaining<ToolContractError>({
        name: "ToolContractError",
        tool: "example",
        stage: "rendering",
      }));
  });
});
