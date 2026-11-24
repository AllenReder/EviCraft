import type { ErasedAbility } from "./ability-runtime.js";
import { isHarnessControlToolName } from "./control-tool-names.js";

/** Built once per run; schema publication and execution share the same definitions. */
export class RunAbilityCatalogue {
  readonly #definitions = new Map<string, ErasedAbility>();
  #frozen = false;

  /** Agent-facing names: the SDK, native Tools and run_code see only these. */
  public get names(): readonly string[] {
    return this.allNames.filter((name) => this.#definitions.get(name)!.visibility !== "internal");
  }
  /** Every registered name, including internal Abilities that only Composites call. */
  public get allNames(): readonly string[] { return [...this.#definitions.keys()].sort(); }
  public get(name: string): ErasedAbility | undefined { return this.#definitions.get(name); }
  public freeze(): void { this.#frozen = true; }
  public register(definition: ErasedAbility): void {
    assertRegistryName(definition.name);
    if (this.#frozen) throw new Error("Ability catalogue is frozen after first use");
    if (this.#definitions.has(definition.name)) throw new Error(`Ability ${definition.name} is already registered`);
    this.#definitions.set(definition.name, definition);
  }
}

const retiredAbilityNames = new Set([
  "navigate", "interact_at", "interact_block", "use_item_on_block_face",
  "attack_entity", "fight_entity", "pickup", "drop_item", "entity_get", "inspect_gui",
  "transfer", "collect_nearby_items", "break_and_collect", "scaffold_materials",
]);

function assertRegistryName(name: string): void {
  if (isHarnessControlToolName(name)) throw new Error(`${name} is reserved for Harness Control Tools`);
  if (retiredAbilityNames.has(name)) throw new Error(`${name} is a retired Agent-facing Ability name`);
  if (name.trim() === "") throw new Error("Ability name must not be empty");
}
