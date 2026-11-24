import type { AbilityInvocationContext } from "../../ability-runtime.js";
import { observeSelfOutput, stripRuntimeOnlySelfFields } from "../built-in/observe_self.js";
import { requiredRuntime } from "./runtime.js";

export async function currentSelf(context: AbilityInvocationContext) {
  return observeSelfOutput.parse(
    stripRuntimeOnlySelfFields(await requiredRuntime(context).call("get_self_status", {}, context.signal)),
    "get_self_status Runtime result",
  );
}
