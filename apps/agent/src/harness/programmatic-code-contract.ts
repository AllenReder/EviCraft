import { harnessControlToolNames } from "./control-tool-names.js";
import { defineToolContract } from "./tool-contract.js";
import { toolSchema as s } from "./tool-schema.js";

const input = s.object({
  description: s.field(s.string({ minLength: 1, pattern: "\\S" }), {
    description: "A clear 5-10 word active-voice operator title for this Programmatic Execution.",
    examples: [
      "Inspect all nearby item entities",
      "Navigate directly to known oak logs",
      "Collect all verified block drops",
    ],
  }),
  code: s.field(s.string(), {
    description: "The body of one async TypeScript function executed against the live abilities namespace.",
  }),
});

const output = s.object({
  logs: s.field(s.array(s.string()), {
    description: "Ordered text explicitly printed by the Programmatic Execution.",
  }),
  result: s.optional(s.losslessJson(), {
    description: "Optional lossless JSON value explicitly returned by the Programmatic Execution.",
  }),
});

const writingGuide = [
  "## Writing code for run_code",
  "`code` is the body of one async TypeScript function, so top-level `await` and `return` are available.",
  "Use erasable TypeScript only. Runtime type stripping removes advisory type annotations; enums, namespaces, and other syntax that requires JavaScript generation are unsupported.",
  "Provide a clear 5-10 word `description` in active voice; it becomes the operator-facing Programmatic Execution title and is not part of the Worker program.",
  "Call an Ability with `await abilities.observe_self({})`. For an exotic name, use quoted access such as `await abilities[\"exotic-name\"]({})`.",
  "Every Ability call resolves to its typed Canonical Ability Result with `ok`, readable `message`, and typed `data`; failures also include stable `error`. Ability arguments, Ability results, and the returned value must be lossless JSON values.",
  "Expected Minecraft outcomes return typed `ok: false` results. Contract and infrastructure failures reject with `ToolCallError`; inspect `error.ability` and the readable `error.message` when recovery is safe.",
  "Use `Promise.all` for independent concurrency-safe calls. Starts and commits follow submission order, and exclusive Abilities hold a barrier through commit.",
  "Sequence dependent work with `await`. Explicitly await every call that must finish; settlement abandons queued calls and cancels and drains started calls.",
  "Store each awaited Ability result, inspect its `ok` discriminator, and pass only verified typed fields into dependent Ability calls.",
  "Only ordered printed output and the returned value enter the Model Surface. Intermediate Ability results stay out unless you print or return them.",
  "### Minecraft continuity",
  "Game time advances only while an action or `wait` is in progress. A loop that only observes does not let time pass: call `await abilities.wait({ seconds })` between checks when waiting for the world to change.",
  "The newest Turn Observation in the current pre-step context is current Embodied World Evidence; older program output is not current World Fact.",
  "Do not call `observe_blocks` routinely: the newest Turn Observation already contains nearby radius-4 block evidence. Call it only when required nearby coordinates are missing, use the smallest radius needed, and do not print or return its raw region payload.",
  "Call `await abilities.observe_self({})` when current Actor evidence is required inside the Programmatic Execution.",
  "Actor replacement, Notification continuity loss, unknown Runtime outcome, and failed Body cleanup are Root-fatal and cannot be recovered with ordinary `try/catch`.",
  "## Available Ability declarations",
].join("\n");

const tool = defineToolContract({
  name: harnessControlToolNames.runCode,
  description: "Execute an ephemeral TypeScript program against the live Minecraft abilities. The `code` argument is the body of an erasable async function where top-level `await` and `return` work. Call Abilities as `await abilities.name(input)`. Only printed output and the returned value enter model context, so curate them.",
  input,
  output,
  render(_input, canonicalOutput) {
    const printed = canonicalOutput.logs.join("");
    if (canonicalOutput.result === undefined) {
      return printed === "" ? "(run_code completed with no output)" : printed;
    }
    const returned = typeof canonicalOutput.result === "string"
      ? canonicalOutput.result
      : JSON.stringify(canonicalOutput.result, null, 2);
    if (printed === "") return returned;
    return `${printed}${printed.endsWith("\n") ? "" : "\n"}${returned}`;
  },
});

export const programmaticCodeContract = Object.freeze({
  tool,
  renderSystemPromptContribution(typescriptSdk: string): string {
    return [
      `Code Mode is fixed for this Harness Run. Call exactly one exposed Tool: ${Object.values(harnessControlToolNames).join(", ")}. Control Tools cannot be called through the abilities namespace.`,
      writingGuide,
      typescriptSdk,
    ].join("\n");
  },
});
