import { open, type FileHandle } from "node:fs/promises";

/** Owns one lazily opened append handle and acknowledges each completed write. */
export class AppendOnlyFile {
  #handle: FileHandle | undefined;
  #tail: Promise<void> = Promise.resolve();
  #firstFailure: { error: unknown } | undefined;
  #closing: Promise<void> | undefined;

  constructor(private readonly path: string, private readonly mode = 0o666) {}

  append(data: string | Uint8Array): Promise<void> {
    if (this.#closing) return Promise.reject(new Error("Append-only file is closing"));
    const operation = this.#tail.then(async () => {
      this.#handle ??= await open(this.path, "a", this.mode);
      await this.#handle.appendFile(data, "utf8");
    });
    // A failed open can be retried by later appends; drain/close retain the first error.
    this.#tail = operation.catch((error: unknown) => { this.#firstFailure ??= { error }; });
    return operation;
  }

  async drain(): Promise<void> {
    await this.#tail;
    if (this.#firstFailure) throw this.#firstFailure.error;
  }

  close(): Promise<void> {
    return this.#closing ??= (async () => {
      await this.#tail;
      try { await this.#handle?.close(); }
      catch (error) {
        if (this.#firstFailure) throw new AggregateError([this.#firstFailure.error, error], "Append and close failed");
        throw error;
      }
      if (this.#firstFailure) throw this.#firstFailure.error;
    })();
  }
}
