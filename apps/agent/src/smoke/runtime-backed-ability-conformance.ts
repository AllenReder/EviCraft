import type { AbilityDefinition } from "../harness/ability-runtime.js";
import { runtimeAbilityMapping } from "../harness/abilities/runtime-backed-ability.js";

export type RuntimeToolWitness = Readonly<{ name: string; execution: "body" | "query" }>;

/** Prove that the real Runtime registers every Tool named by Ability metadata. */
export function assertRuntimeAbilityToolWitnesses(
  definitions: ReadonlyArray<AbilityDefinition<string, unknown, unknown>>,
  witnesses: ReadonlyArray<RuntimeToolWitness>,
): void {
  const registeredNames = new Set(witnesses.map(({ name }) => name));
  const missingNames = definitions.flatMap((definition) => {
    const mapping = runtimeAbilityMapping(definition);
    return mapping !== undefined && !registeredNames.has(mapping.runtimeToolName)
      ? [mapping.runtimeToolName]
      : [];
  }).sort();

  const mismatches = definitions.flatMap((definition) => {
    const mapping = runtimeAbilityMapping(definition);
    const witness = mapping === undefined ? undefined : witnesses.find((tool) => tool.name === mapping.runtimeToolName);
    return witness !== undefined && witness.execution !== definition.execution
      ? [`${definition.name}: Harness ${definition.execution}, Runtime ${witness.execution}`] : [];
  });
  if (mismatches.length > 0) throw new Error(`tool.list execution metadata mismatch: ${mismatches.join("; ")}`);

  if (missingNames.length > 0) {
    throw new Error(
      `tool.list is missing Runtime Tools referenced by Runtime-backed Ability metadata: ${missingNames.join(", ")}`,
    );
  }
}
