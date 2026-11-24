import { activate_block } from "./built-in/activate_block.js";
import { break_block } from "./built-in/break_block.js";
import { use_item } from "./built-in/use_item.js";
import { use_item_on_block } from "./built-in/use_item_on_block.js";
import { place_block } from "./built-in/place_block.js";
import { attack } from "./built-in/attack.js";
import { close_menu } from "./built-in/close_menu.js";
import { collect_items } from "./built-in/collect_items.js";
import { craft_on_current_surface } from "./built-in/craft_on_current_surface.js";
import { drop_items } from "./built-in/drop_items.js";
import { eat } from "./built-in/eat.js";
import { enter_bed } from "./built-in/enter_bed.js";
import { equip_item } from "./built-in/equip_item.js";
import { find_known_blocks } from "./built-in/find_known_blocks.js";
import { goto } from "./built-in/goto.js";
import { goto_block_interaction_pose } from "./built-in/goto_block_interaction_pose.js";
import { goto_block_placement_pose } from "./built-in/goto_block_placement_pose.js";
import { interact_entity } from "./built-in/interact_entity.js";
import { lookup_recipe } from "./built-in/lookup_recipe.js";
import { lookup_registry } from "./built-in/lookup_registry.js";
import { manage_scaffold_materials } from "./built-in/manage_scaffold_materials.js";
import { observe_block } from "./built-in/observe_block.js";
import { observe_blocks } from "./built-in/observe_blocks.js";
import { observe_entities } from "./built-in/observe_entities.js";
import { observe_inventory } from "./built-in/observe_inventory.js";
import { observe_menu } from "./built-in/observe_menu.js";
import { observe_self } from "./built-in/observe_self.js";
import { throw_eye_of_ender } from "./built-in/throw_eye_of_ender.js";
import { transfer_item } from "./built-in/transfer_item.js";
import { wait } from "./built-in/wait.js";
import { mine_down } from "./project-composite/mine_down.js";
import { place_block_nearby } from "./project-composite/place_block_nearby.js";
import { goto_and_activate_block } from "./project-composite/goto_and_activate_block.js";
import { goto_and_break_block } from "./project-composite/goto_and_break_block.js";
import { goto_and_place_block } from "./project-composite/goto_and_place_block.js";
import { goto_and_use_item_on_block } from "./project-composite/goto_and_use_item_on_block.js";
import { collect_blocks } from "./project-composite/collect_blocks.js";
import { craft } from "./project-composite/craft.js";
import { explore_and_return } from "./project-composite/explore_and_return.js";
import { fill_bucket } from "./project-composite/fill_bucket.js";
import { look_around } from "./project-composite/look_around.js";
import { sleep_in_bed } from "./project-composite/sleep_in_bed.js";
import { smelt_at_furnace } from "./project-composite/smelt_at_furnace.js";
import { surface } from "./project-composite/surface.js";
import { suffocation_escape } from "./project-composite/suffocation_escape.js";
import { tunnel_for_blocks } from "./project-composite/tunnel_for_blocks.js";
import type { ScopedAbilityNamespace } from "../ability-runtime.js";

export const runtimeAbilities = [
  activate_block, break_block, use_item, use_item_on_block, place_block, observe_self, observe_inventory, observe_menu, observe_block, observe_blocks, find_known_blocks,
  observe_entities, lookup_registry, lookup_recipe, goto, goto_block_interaction_pose, goto_block_placement_pose, interact_entity, attack,
  collect_items, equip_item, eat, enter_bed, drop_items, craft_on_current_surface, throw_eye_of_ender, transfer_item, close_menu,
  manage_scaffold_materials, wait,
] as const;
export const projectCompositeAbilities = [
  collect_blocks, craft, explore_and_return, fill_bucket, goto_and_activate_block, goto_and_break_block, goto_and_place_block, goto_and_use_item_on_block,
  look_around, mine_down, tunnel_for_blocks,
  place_block_nearby, sleep_in_bed, smelt_at_furnace, surface, suffocation_escape,
] as const;
export const abilities = [...runtimeAbilities, ...projectCompositeAbilities] as const;
export type ProjectAbilityNamespace = ScopedAbilityNamespace<typeof abilities>;

export { blockPositionSchema, knownBlockEvidenceSchema } from "./shared/schemas.js";
