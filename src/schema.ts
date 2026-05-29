/**
 * Schema validation built on the Standard Schema v1 spec
 * (https://standardschema.dev). Agest never imports a schema library — it talks
 * to whatever the consumer brings (zod 4, valibot, arktype, …) through the
 * `~standard` contract every compliant library exposes. zod is the documented,
 * blessed choice but is not a runtime or peer dependency.
 */

/** The minimal Standard Schema v1 interface, vendored from the spec. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output>;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment>;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
}

/** The inferred output type of a Standard Schema (e.g. `z.infer<typeof S>`). */
export type InferOutput<S extends StandardSchemaV1> = NonNullable<
  S["~standard"]["types"]
>["output"];

/** Structural duck-type check so any Standard-Schema library is accepted. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    "~standard" in value &&
    typeof (value as StandardSchemaV1)["~standard"]?.validate === "function"
  );
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Normalise one issue path segment (`PropertyKey | { key }`) to a string. */
function renderSegment(seg: PropertyKey | StandardSchemaV1.PathSegment): string {
  return typeof seg === "object" ? String(seg.key) : String(seg);
}

/** Render Standard Schema failure issues into a readable multi-line message. */
export function formatIssues(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): string {
  const lines = issues.map((issue) => {
    const path = issue.path?.map(renderSegment).join(".");
    return path ? `  • ${path}: ${issue.message}` : `  • ${issue.message}`;
  });
  const count = issues.length;
  return `${count} issue${count !== 1 ? "s" : ""}:\n${lines.join("\n")}`;
}

export type ValidationOutcome =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Validate a value against a schema, awaiting the result. Supports both
 * synchronous and asynchronous (`refine`-style) schemas — used by the runner,
 * which is already async.
 */
export async function validateAgainstSchema(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<ValidationOutcome> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    return { ok: false, message: formatIssues(result.issues) };
  }
  return { ok: true };
}

/**
 * Synchronous validation for the `matchingSchema` matcher (matchers run inside
 * a sync assertion callback). Throws a directive error if the schema needs to
 * resolve asynchronously — declare such schemas at the agent/scene level, where
 * validation is awaited.
 */
export function validateSync(
  schema: StandardSchemaV1,
  value: unknown,
): ValidationOutcome {
  const result = schema["~standard"].validate(value);
  if (isThenable(result)) {
    throw new Error(
      "matchingSchema() cannot validate an async schema. Declare the schema at " +
        "the agent() or scene().expectSchema() level, where validation is awaited.",
    );
  }
  if (result.issues) {
    return { ok: false, message: formatIssues(result.issues) };
  }
  return { ok: true };
}
