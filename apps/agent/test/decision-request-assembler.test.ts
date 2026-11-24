import { describe, expect, it } from "vitest";

import { AbilityRuntime } from "../src/harness/ability-runtime.js";
import {
  decisionContext,
  operatingContract,
} from "../src/harness/decision-request-assembler.js";
import { messageText } from "../src/harness/model-surface-message.js";

describe("Decision Request Assembler", () => {
  describe("operatingContract", () => {
    it("projects the stable system message byte-for-byte in Native Mode", () => {
      const runtime = new AbilityRuntime();
      const contract = operatingContract({
        mode: "native",
        runtime,
        projectSkills: [{ name: "containers", description: "Open and read containers." }],
        vision: false,
      });

      expect(contract.wireText).toBe(
        "<project_skills>\n"
        + "Each Skill's description says when it applies. Before starting work that matches a description, call load_skill with that exact name; the loaded body is not repeated later, so reload it after a long gap. If none applies, continue without loading.\n"
        + '[{"name":"containers","description":"Open and read containers."}]'
        + "\n</project_skills>\n"
        + "<harness_contract>\n"
        + "Native Mode is fixed for this Harness Run. Call exactly one exposed Tool.\n"
        + "Assertions supplied in pre-step context are not World Facts.\n"
        + "</harness_contract>",
      );
      expect(contract.message.role).toBe("system");
      expect(messageText(contract.message)).toBe(contract.wireText);
    });

    it("summarizes the generated Code SDK instead of printing its full body by default", () => {
      const contract = operatingContract({
        mode: "code",
        runtime: runtimeWithAbilities(),
        projectSkills: [],
        vision: false,
      });

      const harnessContract = contract.sections.find((section) => section.title === "Harness Contract");
      expect(harnessContract).toBeDefined();
      expect(harnessContract?.summary).toMatch(/Generated Code SDK · 2 abilities · \d+ lines/u);
      expect(harnessContract?.body).toContain("declare const abilities");
    });

    it("keeps Project Skills readable", () => {
      const contract = operatingContract({
        mode: "native",
        runtime: new AbilityRuntime(),
        projectSkills: [{ name: "containers", description: "Open and read containers." }],
        vision: false,
      });

      expect(contract.sections.map((section) => section.title)).toEqual([
        "Project Skills", "Harness Contract",
      ]);
      const skills = contract.sections.find((section) => section.title === "Project Skills");
      expect(skills?.body).toContain("Each Skill's description says when it applies.");
      expect(skills?.body).toContain('"containers"');
    });
  });

  describe("decisionContext", () => {
    it("projects the fresh user message byte-for-byte from one structured product", () => {
      const context = decisionContext({
        cycle: 1,
        agentContext: { revision: 0, assertions: [{ id: "goal", text: "Collect wood." }] },
        agentPlan: { revision: 2, items: [{ id: "mine" }] },
        navigationPolicy: { action: "read" },
        runtimeOccurrences: [{ type: "damage_received" }],
        renderedObservation: "<turn_observation>\nSELF\nfeet=0,64,0\n</turn_observation>",
      });

      expect(context.wireText).toBe(
        '<minecraft_pre_step_context source="fresh">\n'
        + '{"external_assertions":{"revision":0,"assertions":[{"id":"goal","text":"Collect wood."}]},'
        + '"agent_plan":{"revision":2,"items":[{"id":"mine"}]},'
        + '"navigation_policy":{"action":"read"},'
        + '"runtime_occurrences":[{"type":"damage_received"}],'
        + '"turn_observation":"<turn_observation>\\nSELF\\nfeet=0,64,0\\n</turn_observation>"}'
        + '\n</minecraft_pre_step_context>',
      );
      expect(context.message.role).toBe("user");
      expect(messageText(context.message)).toBe(context.wireText);
    });

    it("names sections with the ubiquitous language and keeps them human-readable", () => {
      const context = decisionContext({
        cycle: 3,
        agentContext: { revision: 0, assertions: [] },
        agentPlan: { revision: 1, items: [] },
        navigationPolicy: { action: "read" },
        runtimeOccurrences: [],
        renderedObservation: "<turn_observation>\nSELF\n</turn_observation>",
      });

      expect(context.sections.map((section) => section.title)).toEqual([
        "External Assertions", "Agent Plan", "Navigation Policy", "Turn Trigger Context", "Turn Observation",
      ]);
      const occurrences = context.sections.find((section) => section.title === "Turn Trigger Context");
      expect(occurrences?.body).toBe("none");
      const observation = context.sections.find((section) => section.title === "Turn Observation");
      expect(observation?.body).toBe("<turn_observation>\nSELF\n</turn_observation>");
      const plan = context.sections.find((section) => section.title === "Agent Plan");
      expect(plan?.body).toContain('"revision": 1');
    });

    it("carries unabsorbed hazard reasons in a minimal trigger field", () => {
      const context = decisionContext({
        cycle: 2,
        agentContext: { revision: 0, assertions: [] },
        agentPlan: { revision: 0, items: [] },
        navigationPolicy: {},
        runtimeOccurrences: [],
        trigger: { hazard_reasons: ["low_air"] },
        renderedObservation: "<turn_observation>\nSELF\n</turn_observation>",
      });

      expect(context.wireText).toBe(
        '<minecraft_pre_step_context source="fresh">\n'
        + '{"external_assertions":{"revision":0,"assertions":[]},'
        + '"agent_plan":{"revision":0,"items":[]},'
        + '"navigation_policy":{},'
        + '"runtime_occurrences":[],'
        + '"trigger":{"hazard_reasons":["low_air"]},'
        + '"turn_observation":"<turn_observation>\\nSELF\\n</turn_observation>"}'
        + '\n</minecraft_pre_step_context>',
      );
      // The trigger persists with the committed cycle's historical context.
      expect(messageText(context.historyMessage)).toContain('"trigger":{"hazard_reasons":["low_air"]}');
      const trigger = context.sections.find((section) => section.title === "Turn Trigger Context");
      expect(trigger?.body).toBe(JSON.stringify({
        runtime_occurrences: [],
        trigger: { hazard_reasons: ["low_air"] },
      }, null, 2));
    });
  });
});

function runtimeWithAbilities(): AbilityRuntime {
  return {
    names: ["observe_self", "wait"],
    typescriptSdk: () => "declare const abilities: { readonly wait: unknown; };",
  } as unknown as AbilityRuntime;
}
