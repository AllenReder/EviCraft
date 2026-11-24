import type { LanguageModel } from "ai";

import type { HarnessSecrets, ModelProvider } from "./config.js";
import { modelProviderAdapter } from "./model-provider-adapter.js";

/** Builds the AI SDK model for one serializable Model Provider route through its Adapter. */
export function createConfiguredLanguageModel(
  route: ModelProvider,
  secrets: HarnessSecrets,
): LanguageModel {
  return modelProviderAdapter(route).createModel(route, secrets);
}
