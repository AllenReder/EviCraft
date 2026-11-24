import { runExplorationExcursionScenario } from "./explore-and-return-surface.js";

/** Proves bounded exploration discovers the elevated marker branch and returns unchanged. */
export const exploreAndReturnBranchingCaveScenario = {
  id: "explore-and-return-branching-cave" as const,
  run: async (context: Parameters<typeof runExplorationExcursionScenario>[0]) =>
    await runExplorationExcursionScenario(context, {
      maxOutboundDisplacement: 20,
      requireBranchRecovery: true,
    }),
};
