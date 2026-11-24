import { defineAbility } from "../../ability-runtime.js";
import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { currentSelf } from "../shared/current-self.js";
import { canonicalIdGlobValue, canonicalIdValue, continuousPosition, toolEmpty, uuidPattern } from "../shared/schemas.js";
import { requiredRuntime } from "../shared/runtime.js";

const entityTrack = s.object({
  uuid: s.field(s.string({ pattern: uuidPattern }), { description: "Stable observed entity UUID." }),
  dimension: s.field(canonicalIdValue, { description: "Canonical dimension registry identifier containing the track." }),
  entity_id: s.field(canonicalIdValue, { description: "Canonical entity-type registry identifier." }),
  item_id: s.optional(canonicalIdValue, { description: "Canonical item id when this track is an item entity." }),
  item_count: s.optional(s.integer({ minimum: 0 }), { description: "Verified stack count when this is an item entity." }),
  position: s.field(continuousPosition, { description: "Last embodied continuous position for the entity track." }),
  state: s.field(s.enumeration("VISIBLE", "KNOWN"), { description: "Current evidence freshness classification." }),
  source: s.field(s.string(), { description: "Evidence source that produced the track." }),
  observed_tick: s.field(s.integer(), { description: "Minecraft server tick when the entity was observed." }),
  observation_revision: s.field(s.integer(), { description: "Monotonic evidence revision containing the track." }),
});
const output = canonicalAbilityResultSchema(s.object({
  operation: s.field(s.literal("entity.list"), { description: "Runtime evidence operation that produced this result." }),
  tracks: s.field(s.array(entityTrack), { description: "Bounded embodied Entity Tracks matching the request." }),
  has_more: s.field(s.boolean(), { description: "Whether more matching tracks existed beyond the result bound." }),
}), toolEmpty);

export const observe_entities = defineAbility({
  name: "observe_entities", description: "Return bounded embodied Entity Tracks, optionally filtered by full-match Canonical ID Globs such as entity_id_glob=minecraft:* or item_id_glob=minecraft:*_ingot; exact entity_get remains SDK-only.",
  concurrency: "safe", execution: "query",
  input: s.object({
    entity_id_glob: s.optional(canonicalIdGlobValue, {
      description: "Optional full-match Canonical ID Glob over canonical entity-type ids.",
      examples: ["minecraft:zombie"],
    }),
    item_id_glob: s.optional(canonicalIdGlobValue, {
      description: "Optional full-match Canonical ID Glob over canonical ids carried by item entities.",
      examples: ["minecraft:*_log"],
    }),
  }),
  output,
  async execute(input, context) {
    const self = await currentSelf(context);
    if (!self.ok) return output.parse(self, "observe_entities self result");
    const data = await requiredRuntime(context).entityList({
      dimension: self.data.dimension,
      ...(input.entity_id_glob === undefined ? {} : { entityIdGlob: input.entity_id_glob }),
      ...(input.item_id_glob === undefined ? {} : { itemIdGlob: input.item_id_glob }),
    });
    return output.parse({ ok: true, message: "bounded embodied entity tracks", data });
  },
});
