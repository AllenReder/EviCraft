export interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

export function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: () => resolvePromise?.() };
}

export async function waitFor(check: () => boolean): Promise<void> {
  while (!check()) await new Promise<void>((resolve) => setImmediate(resolve));
}
