import { describe, expect, it } from "vitest";

import { retainedSmokeArtifacts } from "../src/smoke/error-report.js";

describe("smoke error report", () => {
  it("reports every retained run nested in bounded-work failures", () => {
    const first = Object.assign(new Error("first scenario failed"), {
      retainedRunDirectory: "/tmp/first-run",
      retainedArtifactsDirectory: "/tmp/first-run/artifacts",
    });
    const second = Object.assign(new Error("second scenario failed"), {
      retainedRunDirectory: "/tmp/second-run",
      retainedArtifactsDirectory: "/tmp/second-run/artifacts",
    });
    const aggregate = new AggregateError([
      new Error("first: scenario failed", { cause: first }),
      new Error("second: scenario failed", { cause: second }),
    ], "NeoForge smoke work failed");

    expect(retainedSmokeArtifacts(aggregate)).toEqual([
      { runDirectory: "/tmp/first-run", artifactsDirectory: "/tmp/first-run/artifacts" },
      { runDirectory: "/tmp/second-run", artifactsDirectory: "/tmp/second-run/artifacts" },
    ]);
  });

  it("does not duplicate a retained run reached through aggregate and cause chains", () => {
    const retained = Object.assign(new Error("scenario failed"), {
      retainedRunDirectory: "/tmp/run",
    });
    const wrapper = new Error("scenario: failed", { cause: retained });
    const aggregate = new AggregateError([wrapper], "NeoForge smoke work failed", { cause: wrapper });

    expect(retainedSmokeArtifacts(aggregate)).toEqual([{ runDirectory: "/tmp/run" }]);
  });
});
