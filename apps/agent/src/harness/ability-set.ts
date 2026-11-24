import type { RuntimeInfo } from "@evicraft/runtime-sdk";

import { abilities } from "./abilities/index.js";
import type { AbilitySetMode } from "./config.js";

export const HARNESS_ABILITY_SET_VERSION = "1";

export interface HarnessAbilitySetMetadata {
  readonly version: typeof HARNESS_ABILITY_SET_VERSION;
  readonly mode: AbilitySetMode;
  readonly worldKnowledgeProfile: RuntimeInfo["world_knowledge_profile"];
}

/** This Harness owns its Composite strategies; Runtime profile changes no physical interface. */
export function selectHarnessAbilities(
  worldKnowledgeProfile: RuntimeInfo["world_knowledge_profile"],
  mode: AbilitySetMode,
) {
  const definitions = mode === "profile-default" && worldKnowledgeProfile === "loaded_world_state"
    ? abilities.filter(definition => definition.name !== "explore_and_return" && definition.name !== "tunnel_for_blocks")
    : [...abilities];
  const metadata: HarnessAbilitySetMetadata = Object.freeze({
    version: HARNESS_ABILITY_SET_VERSION,
    mode,
    worldKnowledgeProfile,
  });
  return Object.freeze({ metadata, definitions: Object.freeze(definitions) });
}
