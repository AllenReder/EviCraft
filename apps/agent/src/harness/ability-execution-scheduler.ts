import type { AbilityConcurrency } from "./ability-runtime.js";

/**
 * An Ability call rejected before its execution ever started because its
 * signal was already aborted. Carries the raw abort reason unchanged so the
 * Harness layer can distinguish a queued-not-started call from a started
 * task's cancellation when it normalizes interruption outcomes.
 */
export class AbilityNotStartedError extends Error {
  public readonly reason: unknown;

  public constructor(reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "AbilityNotStartedError";
    this.reason = reason;
  }
}

export class AbilityBodyGate {
  #tail: Promise<void> = Promise.resolve();

  public async run<Value>(signal: AbortSignal, operation: () => Promise<Value>): Promise<Value> {
    let release!: () => void;
    const predecessor = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    try {
      await predecessor;
      if (signal.aborted) throw new AbilityNotStartedError(signal.reason);
      return await operation();
    } finally {
      release();
    }
  }
}

interface ScheduledCall<Value> {
  readonly acquire: () => ScheduledExecution<Value>;
  readonly beforeCommit: Promise<void>;
  readonly releaseCommit: () => void;
  readonly signal: AbortSignal;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
  detachCancellation(): void;
}

interface ScheduledExecution<Value> {
  readonly concurrency: AbilityConcurrency;
  readonly run: (signal: AbortSignal, beforeCommit: () => Promise<void>) => Promise<Value>;
}

let nextRootSequence = 0;

export class CompositeProgramExecutionScope {
  readonly #controller = new AbortController();
  readonly #children = new Set<Promise<unknown>>();
  #detachParentSignal: (() => void) | undefined;

  public constructor(parentSignal: AbortSignal) {
    if (parentSignal.aborted) this.#controller.abort(parentSignal.reason);
    else {
      const abort = () => this.#controller.abort(parentSignal.reason);
      parentSignal.addEventListener("abort", abort, { once: true });
      this.#detachParentSignal = () => parentSignal.removeEventListener("abort", abort);
    }
  }

  public get signal(): AbortSignal { return this.#controller.signal; }

  public track<Value>(promise: Promise<Value>): Promise<Value> {
    const tracked = promise as Promise<unknown>;
    this.#children.add(tracked);
    void tracked.catch(() => undefined);
    void tracked.then(
      () => { this.#children.delete(tracked); },
      () => { this.#children.delete(tracked); },
    );
    return promise;
  }

  public abort(reason: unknown): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
  }

  public async cancelAndDrain(reason: unknown): Promise<void> {
    this.abort(reason);
    try {
      while (this.#children.size > 0) {
        await Promise.allSettled([...this.#children]);
      }
    } finally {
      this.#detachParentSignal?.();
      this.#detachParentSignal = undefined;
    }
  }
}

export class AbilityRootExecution {
  public readonly id = `root-${++nextRootSequence}`;
  readonly #controller = new AbortController();
  readonly #queue: ScheduledCall<unknown>[] = [];
  readonly #active = new Set<Promise<void>>();
  #commitTail: Promise<void> = Promise.resolve();
  #activeSafe = 0;
  #exclusiveActive = false;
  #executionSequence = 0;
  #dispatchCount = 0;
  #failure: unknown;
  #detachExternalSignal: (() => void) | undefined;

  public constructor(signal?: AbortSignal) {
    if (signal?.aborted === true) this.abort(signal.reason);
    else if (signal !== undefined) {
      const abort = () => this.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      this.#detachExternalSignal = () => signal.removeEventListener("abort", abort);
    }
  }

  public get failure(): unknown { return this.#failure; }
  public get signal(): AbortSignal { return this.#controller.signal; }
  public get dispatchCount(): number { return this.#dispatchCount; }

  public recordDispatch(): void {
    this.#dispatchCount += 1;
  }

  public nextExecutionId(): string { return `${this.id}:execution-${++this.#executionSequence}`; }

  public schedule<Value>(
    acquire: () => ScheduledExecution<Value>,
    signal: AbortSignal = this.#controller.signal,
  ): Promise<Value> {
    if (this.#controller.signal.aborted) return Promise.reject(new AbilityNotStartedError(this.#controller.signal.reason));
    if (signal.aborted) return Promise.reject(new AbilityNotStartedError(signal.reason));
    const beforeCommit = this.#commitTail;
    let releaseCommit!: () => void;
    this.#commitTail = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let call!: ScheduledCall<Value>;
    const promise = new Promise<Value>((resolve, reject) => {
      const cancel = () => this.cancelQueued(call, signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      call = {
        acquire,
        beforeCommit,
        releaseCommit,
        signal,
        resolve,
        reject,
        detachCancellation() { signal.removeEventListener("abort", cancel); },
      };
      this.#queue.push(call as ScheduledCall<unknown>);
    });
    this.pump();
    return promise;
  }

  public fail(error: unknown): void {
    this.#failure ??= error;
    this.abort(error);
  }

  public abort(reason: unknown): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
    const pending = this.#queue.splice(0);
    for (const call of pending) {
      call.detachCancellation();
      call.reject(reason);
      this.bridgeCanceledCommit(call);
    }
  }

  public async drain(): Promise<void> {
    try {
      while (this.#queue.length > 0 || this.#active.size > 0) {
        await Promise.allSettled([...this.#active]);
        if (this.#active.size === 0 && this.#queue.length > 0) this.pump();
      }
      await this.#commitTail;
    } finally {
      this.#detachExternalSignal?.();
      this.#detachExternalSignal = undefined;
    }
  }

  private pump(): void {
    if (this.#controller.signal.aborted || this.#exclusiveActive) return;
    const first = this.#queue[0];
    if (first === undefined) return;
    const firstExecution = first.acquire();
    if (firstExecution.concurrency === "exclusive") {
      if (this.#activeSafe !== 0) return;
      this.#queue.shift();
      first.detachCancellation();
      this.#exclusiveActive = true;
      this.start(first, firstExecution);
      return;
    }
    while (this.#activeSafe < 10) {
      const call = this.#queue[0];
      if (call === undefined) break;
      const execution = call === first ? firstExecution : call.acquire();
      if (execution.concurrency !== "safe") break;
      this.#queue.shift();
      call.detachCancellation();
      this.#activeSafe += 1;
      this.start(call, execution);
    }
  }

  private start(call: ScheduledCall<unknown>, execution: ScheduledExecution<unknown>): void {
    const active = Promise.resolve().then(async () => {
      try {
        call.resolve(await execution.run(
          call.signal,
          async () => await call.beforeCommit,
        ));
      }
      catch (error) { call.reject(error); }
    }).finally(() => {
      call.releaseCommit();
      this.#active.delete(active);
      if (execution.concurrency === "safe") this.#activeSafe -= 1;
      else this.#exclusiveActive = false;
      this.pump();
    });
    this.#active.add(active);
  }

  private cancelQueued<Value>(call: ScheduledCall<Value>, reason: unknown): void {
    const erasedCall = call as ScheduledCall<unknown>;
    const index = this.#queue.indexOf(erasedCall);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    call.detachCancellation();
    call.reject(new AbilityNotStartedError(reason));
    this.bridgeCanceledCommit(call);
    this.pump();
  }

  private bridgeCanceledCommit<Value>(call: ScheduledCall<Value>): void {
    void call.beforeCommit.then(call.releaseCommit, call.releaseCommit);
  }
}
