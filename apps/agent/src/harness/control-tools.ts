import { harnessControlToolNames } from "./control-tool-names.js";
import { defineToolContract } from "./tool-contract.js";
import { toolSchema as s } from "./tool-schema.js";

const planItem = s.object({
  id: s.field(s.string(), { description: "Stable caller-chosen identifier for this Plan item." }),
  content: s.field(s.string(), { description: "Human-readable description of the work represented by this item." }),
  status: s.field(s.enumeration("pending", "in_progress", "completed", "cancelled"), {
    description: "Current lifecycle status of this Plan item.",
  }),
});

const skillLoadResult = s.oneOf(
  s.branch(s.object({
    ok: s.field(s.literal(true), { description: "Whether the requested Project Skill content was loaded." }),
    message: s.field(s.string(), { description: "Readable summary of the successful Project Skill load." }),
    data: s.field(s.object({
      name: s.field(s.string(), { description: "Canonical name of the loaded Project Skill." }),
      file: s.field(s.string(), { description: "Selected Skill body or declared reference path." }),
      digest: s.field(s.string(), { description: "Immutable content digest from the current Skill snapshot." }),
      content: s.field(s.string(), { description: "Loaded Project Skill Markdown content." }),
    }), { description: "Verified Project Skill content selected from the immutable snapshot." }),
  }), {
    title: "Loaded Project Skill",
    description: "The requested Skill body or declared reference was loaded successfully.",
  }),
  s.branch(s.object({
    ok: s.field(s.literal(false), { description: "Whether the requested Project Skill content was loaded." }),
    error: s.field(s.enumeration("SKILL_NOT_FOUND", "REFERENCE_NOT_FOUND", "CONTENT_TOO_LARGE"), {
      description: "Stable expected Project Skill load failure code.",
    }),
    message: s.field(s.string(), { description: "Readable explanation of the rejected Project Skill load." }),
    data: s.field(s.object({
      available_names: s.optional(s.array(s.string()), {
        description: "Canonical Skill names in the current snapshot when the requested name was unknown.",
      }),
    }), { description: "Recovery information for a rejected Project Skill load." }),
  }), {
    title: "Rejected Project Skill load",
    description: "The requested Skill or reference is unavailable or exceeds the canonical output budget.",
  }),
);

export const loadSkillControl = defineToolContract({
  name: harnessControlToolNames.loadSkill,
  description: "Load one Project Skill's guidance before starting work that matches its catalog description. Use a name exactly from the Project Skills catalog; reload it when the earlier load is no longer in context.",
  input: s.object({
    name: s.field(s.string(), {
      description: "Exact canonical lower_snake_case name from the current Project Skills catalog. Do not infer or invent names.",
      examples: ["ore_mining"],
    }),
    file: s.optional(s.string(), {
      description: "Omit to load the Skill body. For a reference, use an exact path declared by the selected Skill.",
    }),
  }),
  output: skillLoadResult,
  render(_input, output) {
    return JSON.stringify(output);
  },
});

export const updatePlanControl = defineToolContract({
  name: harnessControlToolNames.updatePlan,
  description: "Atomically replace the Agent Plan with a complete validated list of current work items.",
  input: s.object({
    items: s.field(s.array(planItem), {
      description: "Complete replacement list; Agent Plan domain invariants are validated atomically.",
    }),
  }),
  output: s.object({
    revision: s.field(s.integer({ minimum: 0 }), {
      description: "Monotonic run-local revision after the Plan replacement.",
    }),
    items: s.field(s.array(planItem), {
      description: "Canonical Agent Plan items accepted by the domain validator.",
    }),
  }),
  render(_input, output) {
    return JSON.stringify(output);
  },
});

const viewPoint = s.object({
  x: s.field(s.number(), { description: "Eye X coordinate in blocks." }),
  y: s.field(s.number(), { description: "Eye Y coordinate in blocks." }),
  z: s.field(s.number(), { description: "Eye Z coordinate in blocks." }),
});

const blockPosition = s.object({
  x: s.field(s.integer(), { description: "Block X coordinate." }),
  y: s.field(s.integer(), { description: "Block Y coordinate." }),
  z: s.field(s.integer(), { description: "Block Z coordinate." }),
});

const captureViewResult = s.oneOf(
  s.branch(s.object({
    ok: s.field(s.literal(true), { description: "Whether the view was captured." }),
    data: s.field(s.object({
      dimension: s.field(s.string(), { description: "Dimension the Bot was in when the view was captured." }),
      eye: s.field(viewPoint, { description: "Bot eye position the view was rendered from." }),
      yaw: s.field(s.number(), { description: "Facing actually used, in Minecraft degrees." }),
      pitch: s.field(s.number(), { description: "Vertical angle actually used, in Minecraft degrees." }),
      width: s.field(s.integer({ minimum: 1 }), { description: "Image width in pixels." }),
      height: s.field(s.integer({ minimum: 1 }), { description: "Image height in pixels." }),
      server_tick: s.field(s.integer({ minimum: 0 }), { description: "Server tick at which the Bot pose was sampled." }),
      target: s.optional(blockPosition, { description: "Block whose center the view was aimed at, when one was requested." }),
    }), { description: "Pose of the attached first-person image." }),
  }), {
    title: "Captured view",
    description: "The first-person image follows as the next user message.",
  }),
  s.branch(s.object({
    ok: s.field(s.literal(false), { description: "Whether the view was captured." }),
    error: s.field(s.enumeration("INVALID_ARGUMENTS", "CAMERA_UNAVAILABLE", "CAPTURE_FAILED"), {
      description: "Stable capture failure code.",
    }),
    message: s.field(s.string(), { description: "Readable explanation of the failure." }),
  }), {
    title: "Failed capture",
    description: "No image was produced.",
  }),
);

export const captureViewControl = defineToolContract({
  name: harnessControlToolNames.captureView,
  description: "Turn the Bot's head and look, either in a direction (yaw/pitch) or at the center of one block (target). Returns the Bot's first-person game view.",
  input: s.object({
    yaw: s.optional(s.number({ minimum: -180, maximum: 180 }), {
      description: "Horizontal facing in Minecraft degrees: 0 faces south (+Z), 90 west (-X), 180 or -180 north (-Z), -90 east (+X). Omit to keep the current facing.",
      examples: [0, 90, -90, 180],
    }),
    pitch: s.optional(s.number({ minimum: -90, maximum: 90 }), {
      description: "Vertical angle in Minecraft degrees: -90 straight up, 0 level with the horizon, 90 straight down. Omit to keep the current angle.",
      examples: [0, 30, -30],
    }),
    target: s.optional(blockPosition, {
      description: "Block coordinates to look toward; only the direction to the block center is used. Use instead of yaw and pitch, not together with them.",
    }),
  }),
  output: captureViewResult,
  render(_input, output) {
    return JSON.stringify(output);
  },
});

export const harnessStateControls = [loadSkillControl, updatePlanControl] as const;
