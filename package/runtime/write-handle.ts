/**
 * Package-owned per-write handle.
 *
 * One write, observed as a monotonic stage machine. The handle is thenable —
 * `await write` resolves at `saved`, the local-durability contract every
 * existing mutation keeps — and exposes the later sync fate as level-triggered
 * state: stage and reason are properties, `saved` and `synced` are promises,
 * and subscribers always receive the current truth immediately, so no
 * consumer can miss a transition by attaching late.
 *
 * @module
 */

/**
 * The closed, framework-owned write lifecycle. Stages are monotonic:
 * `saving → saved → syncing → synced | rejected`. `syncing` appears only when
 * the runtime can observe the transport; a runtime without that signal moves
 * writes from `saved` directly to `synced`.
 */
export type WriteStage = "saving" | "saved" | "syncing" | "synced" | "rejected";

/** Why a write settled as `rejected`: the structured cause, code, and reason. */
export type WriteRejection = {
  /**
   * The structured cause: `denied` for a store verdict, `expired` for an
   * intent retired past its lifespan.
   */
  cause: "denied" | "expired";
  /** The sync node's rejection code, or `null` when none was carried. */
  code: string | null;
  /** Human-readable reason text from the adjudicating node. */
  reason: string;
};

/**
 * Raised through {@link WriteHandle.synced} when a write settles as
 * `rejected`: the store adjudicated the write and denied it permanently.
 */
export class WriteRejectedError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "WriteRejectedError";
  /** The structured cause: `denied` or `expired`. */
  readonly rejectionCause: "denied" | "expired";
  /** The adjudicated rejection code, or `null` when none was carried. */
  readonly code: string | null;
  /** The journal id of the rejected write. */
  readonly writeId: string;

  /** Creates the settled rejection carried by a write's `synced` promise. */
  constructor(writeId: string, rejection: WriteRejection) {
    super(rejection.reason);
    this.writeId = writeId;
    this.code = rejection.code;
    this.rejectionCause = rejection.cause;
  }
}

const stageOrder: Record<WriteStage, number> = {
  saving: 0,
  saved: 1,
  syncing: 2,
  synced: 3,
  rejected: 3,
};

type Resolver<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };

function exposedPromise<T>(): { promise: Promise<T>; resolver: Resolver<T> } {
  let resolver: Resolver<T>;
  const promise = new Promise<T>((resolve, reject) => {
    resolver = { resolve, reject };
  });
  // An author is free to never read a stage promise; the handle itself keeps
  // each one observed so an unconsumed rejection cannot escape as a global
  // unhandled-rejection event.
  promise.catch(() => undefined);
  return { promise, resolver: resolver! };
}

/**
 * A single write observed through the author-facing lifecycle.
 *
 * `await write` (the thenable) resolves at `saved` with the write's value —
 * for inserts, the created row. `write.synced` resolves when the store
 * confirms the write and rejects with {@link WriteRejectedError} when the
 * store denies it. `stage` and `reason` are current-state properties;
 * `subscribe` notifies immediately and on every later change.
 */
export class WriteHandle<T> implements PromiseLike<T> {
  readonly #writeId: string;
  readonly #saved: Promise<T>;
  readonly #synced: Promise<T>;
  readonly #savedResolver: Resolver<T>;
  readonly #syncedResolver: Resolver<T>;
  readonly #listeners = new Set<() => void>();
  #stage: WriteStage = "saving";
  #reason: WriteRejection | null = null;
  #value: T | undefined;
  #valueSet = false;
  #batchId: string | null = null;

  /** Creates a handle in `saving`; the runtime advances it via its controller. */
  constructor(writeId: string) {
    this.#writeId = writeId;
    const saved = exposedPromise<T>();
    const synced = exposedPromise<T>();
    this.#saved = saved.promise;
    this.#savedResolver = saved.resolver;
    this.#synced = synced.promise;
    this.#syncedResolver = synced.resolver;
  }

  /** The stable journal id of this write. */
  get writeId(): string {
    return this.#writeId;
  }

  /** The vendor batch id attributing adjudicated verdicts, once known. */
  get batchId(): string | null {
    return this.#batchId;
  }

  /** @internal Records the vendor batch id once the write is accepted. */
  setBatchId(batchId: string | null): void {
    this.#batchId = batchId;
  }

  /** The current lifecycle stage. Monotonic; never moves backwards. */
  get stage(): WriteStage {
    return this.#stage;
  }

  /** The rejection carried by a `rejected` write; `null` in every other stage. */
  get reason(): WriteRejection | null {
    return this.#reason;
  }

  /** Resolves with the write's value once the write is durable on this device. */
  get saved(): Promise<T> {
    return this.#saved;
  }

  /**
   * Resolves with the write's value once the store confirms the write, and
   * rejects with {@link WriteRejectedError} when the store denies it.
   */
  get synced(): Promise<T> {
    return this.#synced;
  }

  /**
   * Awaiting the handle resolves at `saved` — the same local-durability
   * contract as every other mutation promise in the package.
   */
  then<Fulfilled = T, Rejected = never>(
    onfulfilled?: ((value: T) => Fulfilled | PromiseLike<Fulfilled>) | null,
    onrejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null,
  ): Promise<Fulfilled | Rejected> {
    return this.#saved.then(onfulfilled, onrejected);
  }

  /**
   * Observes stage changes. The listener runs immediately with the current
   * state and again after every stage advance, so late subscribers see the
   * same truth as early ones. Returns an idempotent unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    listener();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  /**
   * @internal Advances the monotonic stage machine; later stages never
   * regress. The value supplied at (or before) `saved` is the one both stage
   * promises resolve with.
   */
  advance(stage: Exclude<WriteStage, "rejected">, value?: T): void {
    if (this.#stage === "synced" || this.#stage === "rejected") return;
    if (!this.#valueSet && value !== undefined) {
      this.#value = value;
      this.#valueSet = true;
    }
    if (stageOrder[stage] <= stageOrder[this.#stage]) return;
    this.#stage = stage;
    if (stageOrder[stage] >= stageOrder.saved) this.#savedResolver.resolve(this.#value as T);
    if (stage === "synced") this.#syncedResolver.resolve(this.#value as T);
    this.#emit();
  }

  /** @internal Settles the write as `rejected` with the adjudicated reason. */
  reject(rejection: WriteRejection): void {
    if (this.#stage === "synced" || this.#stage === "rejected") return;
    this.#stage = "rejected";
    this.#reason = rejection;
    // A verdict arrives after local acceptance in the normal flow, but a
    // handle refused before `saved` must still settle both promises.
    const error = new WriteRejectedError(this.#writeId, rejection);
    this.#savedResolver.reject(error);
    this.#syncedResolver.reject(error);
    this.#emit();
  }

  /** @internal Fails every stage promise without entering the `rejected` stage. */
  fail(error: unknown): void {
    if (this.#stage === "synced" || this.#stage === "rejected") return;
    this.#savedResolver.reject(error);
    this.#syncedResolver.reject(error);
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
