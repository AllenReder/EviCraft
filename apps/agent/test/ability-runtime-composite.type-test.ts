import {
  defineAbility,
  defineCompositeAbility,
  toolSchema as s,
  type ScopedAbilityNamespace,
} from "../src/index.js";
import type { ProjectAbilityNamespace } from "../src/harness/abilities/index.js";
import { collect_blocks } from "../src/harness/abilities/project-composite/collect_blocks.js";
import { explore_and_return } from "../src/harness/abilities/project-composite/explore_and_return.js";
import { goto_and_place_block } from "../src/harness/abilities/project-composite/goto_and_place_block.js";
import { mine_down } from "../src/harness/abilities/project-composite/mine_down.js";
import { place_block_nearby } from "../src/harness/abilities/project-composite/place_block_nearby.js";
import { suffocation_escape } from "../src/harness/abilities/project-composite/suffocation_escape.js";
import { tunnel_for_blocks } from "../src/harness/abilities/project-composite/tunnel_for_blocks.js";

const localLeaf = defineAbility({
  name: "local_leaf",
  description: "Return one precisely typed local value.",
  concurrency: "safe",
  input: s.object({
    value: s.field(s.integer(), { description: "Local integer input." }),
  }),
  output: s.object({
    value: s.field(s.integer(), { description: "Local integer output." }),
  }),
  async execute(input) { return input; },
});

type LocalAbilities = ScopedAbilityNamespace<readonly [typeof localLeaf]>;

defineCompositeAbility<LocalAbilities>()({
  name: "local_composite",
  description: "Prove a Composite Program can use a test-local precise namespace.",
  input: s.object({
    value: s.field(s.integer(), { description: "Composite integer input." }),
  }),
  output: s.object({
    value: s.field(s.integer(), { description: "Composite integer output." }),
  }),
  async execute(input, { abilities, signal }) {
    signal.throwIfAborted();
    const result = await abilities.local_leaf(input);
    result.value.toFixed();
    // @ts-expect-error unknown Ability names are not part of the local namespace
    void abilities.missing_leaf({ value: 1 });
    // @ts-expect-error local_leaf requires an integer value
    void abilities.local_leaf({ value: "wrong" });
    return result;
  },
});

defineAbility({
  name: "legacy_composite",
  description: "The Built-in authoring surface cannot create Composite Abilities.",
  // @ts-expect-error Composite Abilities must use defineCompositeAbility with a precise namespace
  execution: "composite",
  input: s.object({}),
  output: s.object({}),
  async execute() { return {}; },
});

type BuiltInContext = Parameters<typeof localLeaf.execute>[1];
const builtInContextHasInvoke: "invoke" extends keyof BuiltInContext ? true : false = false;
void builtInContextHasInvoke;

declare const projectAbilities: ProjectAbilityNamespace;

void collect_blocks.compositeProgram;
void explore_and_return.compositeProgram;
void goto_and_place_block.compositeProgram;
void mine_down.compositeProgram;
void place_block_nearby.compositeProgram;
void suffocation_escape.compositeProgram;
void tunnel_for_blocks.compositeProgram;
void projectAbilities.observe_self({});
void projectAbilities.goto({ y: 64 });
void projectAbilities.goto({ y: 64, route_mutation_permissions: ["OPEN"] });
void projectAbilities.observe_block({ x: 0, y: 64, z: 0 });
void projectAbilities.break_block({ position: { x: 0, y: 64, z: 0 } });
void projectAbilities.wait({ seconds: 0.1 });
void projectAbilities.collect_items({ uuids: ["00000000-0000-4000-8000-000000000001"] });
void projectAbilities.explore_and_return({
  route_seed: 17,
}).then((result) => {
  result.data.route_seed.toFixed();
  result.data.outbound_displacement.toFixed();
  if (result.ok) result.data.start_feet.x.toFixed();
});
// @ts-expect-error unknown Ability names are not part of the Project Ability Namespace
void projectAbilities.missing_project_ability({});
// @ts-expect-error goto elevation input requires an integer
void projectAbilities.goto({ y: "wrong" });
// @ts-expect-error goto Route Mutation Permission has a closed value set
void projectAbilities.goto({ y: 64, route_mutation_permissions: ["FLY"] });
const blockPosition = { x: 4, y: 64, z: -2 };
void projectAbilities.goto_and_break_block({ position: blockPosition }).then((result) => {
  result.data.position.x.toFixed();
  result.data.cleared_occluding_blocks.forEach((clearing) => clearing.block_state.toUpperCase());
  if (result.ok) {
    result.data.observed_drop_entities.forEach((drop) => drop.item_id.toUpperCase());
  }
  // @ts-expect-error compact break results do not expose child-call history
  result.data.initial;
});
void projectAbilities.goto_and_activate_block({ position: blockPosition }).then((result) => {
  result.data.position.x.toFixed();
  if (result.ok && result.data.outcome === "block_state_changed") {
    result.data.block_state.toUpperCase();
  }
  // @ts-expect-error compact activation results do not expose child-call history
  result.data.initial;
});
void projectAbilities.goto_and_place_block({
  item_id: "minecraft:cobblestone", position: blockPosition,
}).then((result) => {
  result.data.initial.message.toUpperCase();
  if (result.data.approach?.ok) result.data.approach.data.feet.y.toFixed();
  result.data.retry?.data.position.z.toFixed();
});
void projectAbilities.goto_block_placement_pose({
  item_id: "minecraft:cobblestone", position: blockPosition,
}).then((result) => {
  if (result.ok) result.data.feet.y.toFixed();
  else result.data.item_id.toUpperCase();
});
void projectAbilities.place_block_nearby({ item_id: "minecraft:cobblestone" }).then((result) => {
  result.data.attempted_count.toFixed();
  if (result.ok) {
    result.data.successful_position.x.toFixed();
    result.data.placement.data.position.y.toFixed();
  } else {
    result.data.last_attempt?.result.message.toUpperCase();
  }
});
// @ts-expect-error break_block requires its exact nested position input
void projectAbilities.break_block(blockPosition);
// @ts-expect-error interaction-pose input does not accept unrelated fields
void projectAbilities.goto_block_interaction_pose({ position: blockPosition, radius: 2 });
// @ts-expect-error placement-pose input requires the carried BlockItem id
void projectAbilities.goto_block_placement_pose({ position: blockPosition });
// @ts-expect-error goto-and-place input requires the carried BlockItem id
void projectAbilities.goto_and_place_block({ position: blockPosition });
// @ts-expect-error observe_block accepts the exact cell rather than a position wrapper
void projectAbilities.observe_block({ position: { x: 0, y: 64, z: 0 } });
// @ts-expect-error break_block requires a position wrapper around the exact cell
void projectAbilities.break_block({ x: 0, y: 64, z: 0 });
// @ts-expect-error collect_items UUID mode requires the exact uuids field
void projectAbilities.collect_items({ uuid: "00000000-0000-4000-8000-000000000001" });
// @ts-expect-error nearby placement accepts only its exact carried item id
void projectAbilities.place_block_nearby({ item_id: "minecraft:cobblestone", position: blockPosition });
