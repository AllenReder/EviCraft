import {
  renderToolSchemaTypeScript,
  toolSchema as s,
  type InferToolSchema,
  type ToolSchema,
} from "./tool-schema.js";

export type CanonicalAbilityError = "RUNTIME_FAILED" | "INTERRUPTED";

export type CanonicalAbilityResult<Success, Failure> =
  | Readonly<{ ok: true; message: string; data: Success }>
  | Readonly<{ ok: false; error: CanonicalAbilityError; message: string; data: Failure }>;

export interface CanonicalAbilityResultSchema<Success, Failure>
  extends ToolSchema<CanonicalAbilityResult<Success, Failure>> {
  readonly abilitySdkType: string;
}

const errorSchema = s.enumeration("RUNTIME_FAILED", "INTERRUPTED");

export function canonicalAbilityResultSchema<
  SuccessSchema extends ToolSchema<unknown>,
  FailureSchema extends ToolSchema<unknown>,
>(
  successData: SuccessSchema,
  failureData: FailureSchema,
): CanonicalAbilityResultSchema<InferToolSchema<SuccessSchema>, InferToolSchema<FailureSchema>> {
  const schema = s.oneOf(
    s.branch(s.object({
      ok: s.field(s.literal(true), { description: "Whether the Ability completed successfully." }),
      message: s.field(s.string(), { description: "Readable context about the verified Ability outcome." }),
      data: s.field(successData, { description: "Verified Ability-specific success data." }),
    }), {
      title: "Ability success",
      description: "The Ability completed and returned verified success data.",
    }),
    s.branch(s.object({
      ok: s.field(s.literal(false), { description: "Whether the Ability completed successfully." }),
      error: s.field(errorSchema, { description: "Stable expected-failure category for programmatic recovery." }),
      message: s.field(s.string(), { description: "Readable context about the expected Ability failure." }),
      data: s.field(failureData, { description: "Verified Ability-specific failure or partial-progress data." }),
    }), {
      title: "Expected Ability failure",
      description: "The Ability reached an expected Minecraft outcome without an infrastructure error.",
    }),
  );
  return Object.freeze({
    ...schema,
    abilitySdkType: `CanonicalAbilityResult<${renderToolSchemaTypeScript(successData)}, ${renderToolSchemaTypeScript(failureData)}>`,
  }) as CanonicalAbilityResultSchema<InferToolSchema<SuccessSchema>, InferToolSchema<FailureSchema>>;
}

type FailureVariantData<Variant> = Variant extends Readonly<{ data: ToolSchema<infer Data> }> ? Data : never;

export function canonicalAbilityResultVariants<
  SuccessSchema extends ToolSchema<unknown>,
  const Failures extends readonly Readonly<{
    error: CanonicalAbilityError;
    data: ToolSchema<unknown>;
    title: string;
    description: string;
  }>[],
>(
  successData: SuccessSchema,
  failures: Failures,
): CanonicalAbilityResultSchema<InferToolSchema<SuccessSchema>, FailureVariantData<Failures[number]>> {
  const success = s.branch(s.object({
    ok: s.field(s.literal(true), { description: "Whether the Ability completed successfully." }),
    message: s.field(s.string(), { description: "Readable context about the verified Ability outcome." }),
    data: s.field(successData, { description: "Verified Ability-specific success data." }),
  }), {
    title: "Ability success",
    description: "The Ability completed and returned verified success data.",
  });
  const failureBranches = failures.map((failure) => s.branch(s.object({
    ok: s.field(s.literal(false), { description: "Whether the Ability completed successfully." }),
    error: s.field(s.literal(failure.error), { description: "Stable expected-failure category for recovery." }),
    message: s.field(s.string(), { description: "Readable context about the expected Ability failure." }),
    data: s.field(failure.data, { description: "Verified Ability-specific failure or partial-progress data." }),
  }), { title: failure.title, description: failure.description }));
  const schema = s.oneOf(success, ...failureBranches) as ToolSchema<CanonicalAbilityResult<unknown, unknown>>;
  const failureType = failures.map((failure) => renderToolSchemaTypeScript(failure.data)).join(" | ") || "never";
  return Object.freeze({
    ...schema,
    abilitySdkType: `CanonicalAbilityResult<${renderToolSchemaTypeScript(successData)}, ${failureType}>`,
  }) as CanonicalAbilityResultSchema<InferToolSchema<SuccessSchema>, FailureVariantData<Failures[number]>>;
}

export function abilitySdkOutputType(schema: ToolSchema<unknown>): string {
  return isCanonicalAbilityResultSchema(schema) ? schema.abilitySdkType : renderToolSchemaTypeScript(schema);
}

function isCanonicalAbilityResultSchema(
  schema: ToolSchema<unknown>,
): schema is CanonicalAbilityResultSchema<unknown, unknown> {
  return "abilitySdkType" in schema && typeof schema.abilitySdkType === "string";
}
