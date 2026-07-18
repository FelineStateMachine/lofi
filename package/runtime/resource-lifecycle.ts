export type SerializedResourceState<T> = {
  // Package-owned resource lifecycle.
  value: T | null;
  promise: Promise<T> | null;
  queue: Promise<void>;
  recreation: Promise<T> | null;
};

export function createSerializedResourceState<T>(): SerializedResourceState<T> {
  return { value: null, promise: null, queue: Promise.resolve(), recreation: null };
}

function enqueue<T, R>(
  state: SerializedResourceState<T>,
  operation: () => Promise<R>,
): Promise<R> {
  const result = state.queue.then(operation, operation);
  state.queue = result.then(() => undefined, () => undefined);
  return result;
}

export function getResource<T>(
  state: SerializedResourceState<T>,
  create: () => Promise<T>,
): Promise<T> {
  if (state.promise) return state.promise;
  const pending = enqueue(state, async () => {
    if (state.value) return state.value;
    const value = await create();
    state.value = value;
    return value;
  });
  const tracked = pending.catch((error) => {
    if (state.promise === tracked) state.promise = null;
    throw error;
  });
  state.promise = tracked;
  return tracked;
}

function swapResource<T>(
  state: SerializedResourceState<T>,
  prepare: (() => Promise<void>) | null,
  create: () => Promise<T>,
  destroy: (value: T) => Promise<void>,
): Promise<T> {
  const recreation = enqueue(state, async () => {
    if (prepare) await prepare();
    const previous = state.value;
    state.value = null;
    state.promise = null;
    if (previous) await destroy(previous);
    // Browser SharedWorker port shutdown completes on a later task even after
    // the Db shutdown promise resolves. Yield once before opening the replacement
    // so the new persistent client does not attach to the retiring broker.
    if (previous) await new Promise((resolve) => setTimeout(resolve, 50));
    const value = await create();
    state.value = value;
    state.promise = Promise.resolve(value);
    return value;
  });
  const tracked = recreation.finally(() => {
    if (state.recreation === tracked) state.recreation = null;
  });
  state.recreation = tracked;
  return tracked;
}

export function recreateResource<T>(
  state: SerializedResourceState<T>,
  create: () => Promise<T>,
  destroy: (value: T) => Promise<void>,
): Promise<T> {
  if (state.recreation) return state.recreation;
  return swapResource(state, null, create, destroy);
}

/**
 * Replaces a serialized resource after an async preparation step. Unlike
 * {@link recreateResource}, replacement carries a payload (the preparation),
 * so it never aliases to an in-flight recreation: it queues behind it and
 * always runs its own preparation before installing the replacement.
 */
export function replaceResource<T>(
  state: SerializedResourceState<T>,
  prepare: () => Promise<void>,
  create: () => Promise<T>,
  destroy: (value: T) => Promise<void>,
): Promise<T> {
  return swapResource(state, prepare, create, destroy);
}

export function shutdownResource<T>(
  state: SerializedResourceState<T>,
  destroy: (value: T) => Promise<void>,
): Promise<void> {
  return enqueue(state, async () => {
    const value = state.value;
    state.value = null;
    state.promise = null;
    if (value) await destroy(value);
  });
}

export class AdapterDisposedError extends Error {
  override name = "AdapterDisposedError";
}

export class AdapterLifecycle<Dependency, Instance> {
  #disposed = false;
  #generation = 0;
  #instance: Instance | null = null;
  #promise: Promise<Instance> | null = null;

  get(
    acquire: () => Promise<Dependency>,
    attach: (dependency: Dependency) => Instance,
  ): Promise<Instance> {
    if (this.#disposed) return Promise.reject(new AdapterDisposedError("adapter module disposed"));
    if (this.#promise) return this.#promise;
    const generation = this.#generation;
    const pending = acquire().then((dependency) => {
      if (this.#disposed || generation !== this.#generation) {
        throw new AdapterDisposedError("adapter lifecycle changed before attach");
      }
      const instance = attach(dependency);
      this.#instance = instance;
      return instance;
    });
    const tracked = pending.catch((error) => {
      if (this.#promise === tracked) this.#promise = null;
      throw error;
    });
    this.#promise = tracked;
    return tracked;
  }

  async release(close: (instance: Instance) => Promise<void>): Promise<void> {
    this.#generation += 1;
    const instance = this.#instance;
    this.#instance = null;
    this.#promise = null;
    if (instance) await close(instance);
  }

  dispose(close: (instance: Instance) => Promise<void>): void {
    this.#disposed = true;
    void this.release(close);
  }
}
