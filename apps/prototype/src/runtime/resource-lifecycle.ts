export type SerializedResourceState<T> = {
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

export function recreateResource<T>(
  state: SerializedResourceState<T>,
  create: () => Promise<T>,
  destroy: (value: T) => Promise<void>,
): Promise<T> {
  if (state.recreation) return state.recreation;
  const recreation = enqueue(state, async () => {
    const previous = state.value;
    state.value = null;
    state.promise = null;
    if (previous) await destroy(previous);
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
