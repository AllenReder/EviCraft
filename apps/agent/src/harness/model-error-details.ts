import { APICallError, RetryError } from "ai";

/** Persist error evidence, never the SDK request, headers, or entire error object. */
export interface ModelErrorDetails {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
  readonly statusCode?: number;
  readonly providerMessage?: string;
  readonly responseBody?: string;
  readonly truncated?: boolean;
  readonly cause?: ModelErrorDetails;
  readonly errors?: readonly ModelErrorDetails[];
}

export function modelErrorDetails(error: unknown): ModelErrorDetails {
  return describe(error, new Set(), 0);
}

function describe(error: unknown, seen: Set<object>, depth: number): ModelErrorDetails {
  if (error === null || typeof error !== "object") return { name: "Error", message: clean(String(error)) };
  if (seen.has(error) || depth >= 8) return { name: "Error", message: "Error cause chain truncated", truncated: true };
  seen.add(error);
  const value = error as Record<string, unknown>;
  const message = typeof value.message === "string" ? value.message : "Unknown model error";
  const result: ModelErrorDetails = {
    name: typeof value.name === "string" ? clean(value.name) : "Error",
    message: clean(message),
    ...(typeof value.code === "string" || typeof value.code === "number" ? { code: typeof value.code === "string" ? clean(value.code) : value.code } : {}),
    ...(typeof value.statusCode === "number" ? { statusCode: value.statusCode } : {}),
    ...(message.length > 16384 ? { truncated: true } : {}),
  };
  let provider: Record<string, unknown> = {};
  if (APICallError.isInstance(error)) {
    let data: unknown = error.data;
    if (data === undefined && error.responseBody !== undefined) {
      try { data = JSON.parse(error.responseBody); } catch { /* Plain-text/HTML upstream errors are retained below. */ }
    }
    if (data !== null && typeof data === "object") {
      const root = data as Record<string, unknown>;
      provider = root.error !== null && typeof root.error === "object" ? root.error as Record<string, unknown> : root;
    }
  }
  const responseBody = APICallError.isInstance(error) ? error.responseBody : undefined;
  const cause = RetryError.isInstance(error) ? error.lastError : value.cause;
  return {
    ...result,
    ...(typeof provider.code === "string" || typeof provider.code === "number" ? { code: typeof provider.code === "string" ? clean(provider.code) : provider.code } : {}),
    ...(typeof provider.message === "string" ? { providerMessage: clean(provider.message) } : {}),
    ...(responseBody === undefined ? {} : { responseBody: clean(responseBody), ...(responseBody.length > 16384 ? { truncated: true } : {}) }),
    ...(cause === undefined ? {} : { cause: describe(cause, seen, depth + 1) }),
    ...(error instanceof AggregateError ? { errors: error.errors.slice(0, 8).map(nested => describe(nested, seen, depth + 1)),
      ...(error.errors.length > 8 ? { truncated: true } : {}) } : {}),
  };
}

function clean(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s"'<>\\]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .slice(0, 16384);
}
