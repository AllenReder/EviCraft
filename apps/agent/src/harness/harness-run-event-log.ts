import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AppendOnlyFile } from "@evicraft/server-host";

const isRawJSON: ((value: unknown) => boolean) | undefined = Reflect.get(JSON, "isRawJSON");

export interface CommittedHarnessEvent {
  readonly sequence: number;
  readonly event: Readonly<Record<string, unknown> & { readonly type: string }>;
}

export class HarnessRunEventLog {
  public readonly path: string;
  #tail: Promise<void> = Promise.resolve();
  #firstFailure: Readonly<{ error: unknown }> | undefined;
  #subscriber: ((event: CommittedHarnessEvent) => void | Promise<void>) | undefined;
  #nextSequence = 1;
  readonly #writer: AppendOnlyFile;
  #closing: Promise<void> | undefined;

  private constructor(
    runDirectory: string,
    onCommittedEvent?: (event: CommittedHarnessEvent) => void | Promise<void>,
  ) {
    this.path = join(runDirectory, "events.jsonl");
    this.#writer = new AppendOnlyFile(this.path, 0o600);
    this.#subscriber = onCommittedEvent;
  }

  public static async create(
    artifactsDirectory: string,
    runLabel: string,
    onCommittedEvent?: (event: CommittedHarnessEvent) => void | Promise<void>,
  ): Promise<HarnessRunEventLog> {
    const runDirectory = join(artifactsDirectory, runLabel);
    await mkdir(artifactsDirectory, { recursive: true });
    await mkdir(runDirectory, { recursive: false, mode: 0o700 });
    return new HarnessRunEventLog(runDirectory, onCommittedEvent);
  }

  public commit(event: Readonly<Record<string, unknown> & { type: string }>): Promise<void> {
    if (this.#closing) return Promise.reject(new Error("Harness run event log is closing"));
    const operation = this.#tail.then(async () => {
      let containsRawJSON = false;
      const serialized = JSON.stringify(event, isRawJSON === undefined ? undefined : (_key, value: unknown) => {
        containsRawJSON ||= isRawJSON(value);
        return value;
      });
      const durableEvent = JSON.parse(serialized) as Readonly<Record<string, unknown> & { readonly type: string }>;
      const sequence = this.#nextSequence++;
      const envelope: CommittedHarnessEvent = Object.freeze({
        sequence,
        event: Object.freeze(durableEvent),
      });

      // Ordinary event keys follow the header. Preserve spread semantics for
      // reserved/index keys and unusual toJSON results via the original encoding.
      const reusable = !containsRawJSON && serialized !== "{}" && durableEvent !== null && typeof durableEvent === "object" && !Array.isArray(durableEvent)
        && !Object.keys(durableEvent).some(key => key === "version" || key === "sequence" || /^\d/u.test(key));
      const line = reusable
        ? `{"version":5,"sequence":${sequence},${serialized.slice(1)}`
        : JSON.stringify({ version: 5, sequence, ...durableEvent });
      await this.#writer.append(line + "\n");
      const subscriber = this.#subscriber;
      if (subscriber === undefined) return;
      try {
        await subscriber(envelope);
      } catch (error) {
        this.#subscriber = undefined;
        this.#firstFailure ??= { error };
        throw error;
      }
    });
    this.#tail = operation.catch((error: unknown) => {
      this.#firstFailure ??= { error };
    });
    void operation.catch(() => {});
    return operation;
  }

  public async drain(): Promise<void> {
    await this.#tail;
    if (this.#firstFailure !== undefined) throw this.#firstFailure.error;
  }

  public close(): Promise<void> {
    return this.#closing ??= (async () => {
      await this.#tail;
      try { await this.#writer.close(); }
      catch (error) {
        if (this.#firstFailure && this.#firstFailure.error !== error) {
          throw new AggregateError([this.#firstFailure.error, error], "Harness journal and close failed", { cause: this.#firstFailure.error });
        }
        throw error;
      }
      if (this.#firstFailure) throw this.#firstFailure.error;
    })();
  }
}
