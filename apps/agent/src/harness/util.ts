export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One signal that aborts when any of the given signals does; `undefined` when none is given. */
export function anySignal(...signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length <= 1 ? present[0] : AbortSignal.any(present);
}
