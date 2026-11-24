export interface RetainedSmokeArtifacts {
  readonly runDirectory: string;
  readonly artifactsDirectory?: string;
}

export function retainedSmokeArtifacts(error: unknown): readonly RetainedSmokeArtifacts[] {
  const retained: RetainedSmokeArtifacts[] = [];
  collectRetainedArtifacts(error, retained, new Set<object>());
  return retained;
}

function collectRetainedArtifacts(
  error: unknown,
  retained: RetainedSmokeArtifacts[],
  seen: Set<object>,
): void {
  if (error === null || typeof error !== "object" || seen.has(error)) return;
  seen.add(error);

  if ("retainedRunDirectory" in error && typeof error.retainedRunDirectory === "string") {
    retained.push({
      runDirectory: error.retainedRunDirectory,
      ...("retainedArtifactsDirectory" in error
        && typeof error.retainedArtifactsDirectory === "string"
        ? { artifactsDirectory: error.retainedArtifactsDirectory }
        : {}),
    });
  }
  if (error instanceof AggregateError) {
    for (const child of error.errors) collectRetainedArtifacts(child, retained, seen);
  }
  if (error instanceof Error && "cause" in error) {
    collectRetainedArtifacts(error.cause, retained, seen);
  }
}
