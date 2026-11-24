import { describe, expect, it, vi } from "vitest";

import {
  parseRuntimeSdkSmokeScope,
  selectRuntimeSdkSmokeScenario,
  SUPPORTED_RUNTIME_SDK_SMOKE_SCOPES,
} from "../src/smoke/runtime-sdk-smoke.js";
import { runRuntimeSdkSmoke } from "../src/smoke/neoforge-smoke-run.js";

describe("NeoForge SDK smoke scope", () => {
  it("accepts the default and every supported focused scope", () => {
    expect(parseRuntimeSdkSmokeScope(undefined)).toBeUndefined();
    for (const scope of SUPPORTED_RUNTIME_SDK_SMOKE_SCOPES) {
      expect(parseRuntimeSdkSmokeScope(scope)).toBe(scope);
    }
  });

  it("selects the owning scenario for every supported scope without loading the smoke script", () => {
    expect(selectRuntimeSdkSmokeScenario(undefined)).toBe("default-sdk");
    expect(
      Object.fromEntries(
        SUPPORTED_RUNTIME_SDK_SMOKE_SCOPES.map((scope) => [
          scope,
          selectRuntimeSdkSmokeScenario(scope),
        ]),
      ),
    ).toEqual({
      activation: "default-sdk",
      collect_blocks_reselection: "collect-blocks-reselection",
      craft: "default-sdk",
      eye: "default-sdk",
      inventory: "default-sdk",
      occlusion_and_reselection: "occlusion-and-reselection",
      occurrence_and_hazards: "occurrence-and-hazards",
      menu: "default-sdk",
      mine_down: "mine-down",
      obsidian: "obsidian-portal",
      occluding_break: "occluding-break",
      profile: "world-knowledge-profile",
      search: "default-sdk",
      simulation_suspension: "simulation-suspension",
    });
  });

  it("rejects an unknown scope before a NeoForge Smoke Run can start", () => {
    expect(() => parseRuntimeSdkSmokeScope("not-a-smoke-scope")).toThrow(
      "Unknown Runtime SDK Smoke scope not-a-smoke-scope",
    );
  });

  it("rejects an unknown scope before spawning a NeoForge process", async () => {
    const spawn = vi.fn((): never => {
      throw new Error("unexpected NeoForge spawn");
    });

    await expect(
      runRuntimeSdkSmoke({
        scope: "not-a-smoke-scope",
        testing: { spawn },
      }),
    ).rejects.toThrow("Unknown Runtime SDK Smoke scope not-a-smoke-scope");
    expect(spawn).not.toHaveBeenCalled();
  });
});
