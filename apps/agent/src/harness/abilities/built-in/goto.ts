import { canonicalAbilityResultSchema } from "../../canonical-ability-result.js";
import { toolSchema as s } from "../../tool-schema.js";
import { defineInputTranslatedRuntimeAbility } from "../runtime-backed-ability.js";

const integerCoordinate = s.integer();
const routeMutationPermissions = {
  route_mutation_permissions: s.optional(
    s.array(s.enumeration("OPEN", "BREAK", "PLACE"), {
      maxItems: 3,
      uniqueItems: true,
    }),
    {
      description: "Route Mutation kinds this navigation may use. Omit for full OPEN, BREAK, and PLACE traversal; an empty set permits no Route Mutation.",
    },
  ),
};
const gotoInput = s.oneOf(
  s.branch(s.object({
    x: s.field(integerCoordinate, {
      description: "Target block-column X coordinate in the current dimension.",
      examples: [128],
    }),
    z: s.field(integerCoordinate, {
      description: "Target block-column Z coordinate in the current dimension.",
      examples: [-32],
    }),
    ...routeMutationPermissions,
  }), {
    title: "XZ mode",
    description: "Navigate to a supported feet cell in the requested X/Z column.",
  }),
  s.branch(s.object({
    x: s.field(integerCoordinate, {
      description: "Exact target Feet Cell X coordinate in the current dimension.",
      examples: [128],
    }),
    y: s.field(integerCoordinate, {
      description: "Exact target Feet Cell Y coordinate in blocks.",
      examples: [64],
    }),
    z: s.field(integerCoordinate, {
      description: "Exact target Feet Cell Z coordinate in the current dimension.",
      examples: [-32],
    }),
    exact: s.optional(s.boolean(), {
      description: "When true, fail instead of finishing on a nearby supported cell if this exact Feet Cell cannot be reached.",
      default: false,
    }),
    ...routeMutationPermissions,
  }), {
    title: "XYZ mode",
    description: "First attempt the exact integer Feet Cell before any supported fallback; exact disables the fallback.",
  }),
  s.branch(s.object({
    y: s.field(integerCoordinate, {
      description: "Target elevation as an integer Feet Cell Y coordinate in blocks.",
      examples: [12],
    }),
    ...routeMutationPermissions,
  }), {
    title: "Y mode",
    description: "Navigate to a supported position at the requested elevation.",
  }),
  s.branch(s.object({
    block_id_glob: s.field(s.string({ pattern: "^[a-z0-9_.:/?*-]{1,256}$" }), {
      description: "Full-match Canonical ID Glob over remembered canonical block registry identifiers.",
      examples: ["minecraft:*_log"],
    }),
    ...routeMutationPermissions,
  }), {
    title: "Block mode",
    description: "Navigate beside the easiest reachable remembered block whose canonical id fully matches.",
  }),
);

const gotoData = s.object({
  position: s.field(s.object({
    x: s.field(s.number(), { description: "Continuous X position.", examples: [128.5] }),
    y: s.field(s.number(), { description: "Continuous Y position of the feet.", examples: [64] }),
    z: s.field(s.number(), { description: "Continuous Z position.", examples: [-31.5] }),
  }), { description: "Verified final position of the Runtime Bot." }),
  ground_y: s.field(s.integer(), {
    description: "Verified supporting block Y coordinate beneath the final Feet Cell.",
    examples: [63],
  }),
});
const gotoFailureData = s.oneOf(
  s.branch(s.object({}), {
    title: "No verified progress",
    description: "The failure did not verify a final navigation position.",
  }),
  s.branch(gotoData, {
    title: "Verified final position",
    description: "The failure retains the Runtime Bot's verified final navigation position.",
  }),
);
const gotoResult = canonicalAbilityResultSchema(gotoData, gotoFailureData);

export const goto = defineInputTranslatedRuntimeAbility({
  name: "goto",
  description: "Navigate by column, exact feet cell, elevation, or remembered block ID. Coordinate goals may finish at a supported position within three blocks, or within one elevation for Y mode, unless XYZ mode sets exact; inspect final coordinates.",
  execution: "body", input: gotoInput, output: gotoResult,
  runtimeToolName: "goto",
  // The Runtime takes an explicit goal object; the Agent-facing modes above name the same four goals.
  translateInput(value) {
    const permissions = value.route_mutation_permissions === undefined
      ? {} : { route_mutation_permissions: value.route_mutation_permissions };
    if ("block_id_glob" in value) return { goal: { kind: "block", block_id_glob: value.block_id_glob }, ...permissions };
    if (!("x" in value)) return { goal: { kind: "elevation", y: value.y }, ...permissions };
    if (!("y" in value)) return { goal: { kind: "column", x: value.x, z: value.z }, ...permissions };
    return {
      goal: {
        kind: "cell", position: { x: value.x, y: value.y, z: value.z },
        ...(value.exact === undefined ? {} : { exact: value.exact }),
      },
      ...permissions,
    };
  },
});
