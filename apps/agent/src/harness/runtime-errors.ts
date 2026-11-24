export type SetupFailureCode =
  | "CONFIG_INVALID"
  | "RUNTIME_CONNECTION_FAILED"
  | "BOT_RESOLUTION_FAILED"
  | "INTERNAL_ERROR";

export class ActorUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ActorUnavailableError";
  }
}

export class RuntimeConnectionError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeConnectionError";
  }
}
