import { describe, expect, it, vi } from "vitest";

import { AbilityRuntime, defineAbility } from "../src/harness/ability-runtime.js";
import { validateHarnessConfig } from "../src/harness/config.js";
import { toolSchema as s } from "../src/harness/tool-schema.js";

describe("World Knowledge Profile ownership", () => {
  it("cannot be selected by a Harness Run configuration", () => {
    expect(() => validateHarnessConfig({
      world_knowledge_profile: "loaded_world_state",
    })).toThrow(/world_knowledge_profile is not supported/iu);
  });

  it("cannot be selected by an Ability input", async () => {
    const execute = vi.fn(async () => ({ ok: true as const }));
    const runtime = new AbilityRuntime();
    await runtime.register(defineAbility({
      name: "profile_probe",
      description: "Profile-neutral test Ability.",
      concurrency: "safe",
      input: s.object({}),
      output: s.losslessJson(),
      execute,
    }));

    await expect(runtime.dispatch("profile_probe", {
      world_knowledge_profile: "loaded_world_state",
    })).rejects.toThrow(/world_knowledge_profile/iu);
    expect(execute).not.toHaveBeenCalled();
  });
});
