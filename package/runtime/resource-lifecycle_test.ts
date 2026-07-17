import {
  // Package contract tests.
  AdapterDisposedError,
  AdapterLifecycle,
  createSerializedResourceState,
  getResource,
  recreateResource,
  shutdownResource,
} from "./resource-lifecycle.ts";
import { assert, assertCount } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

test("concurrent recreation is single-flight and shutdown is idempotent", async () => {
  const state = createSerializedResourceState<{ id: number }>();
  let created = 0;
  let destroyed = 0;
  const create = () => Promise.resolve({ id: ++created });
  const destroy = (_value: { id: number }) => {
    destroyed += 1;
    return Promise.resolve();
  };

  const initial = await getResource(state, create);
  assert(initial.id === 1, "the initial client must be created once");
  const [first, second] = await Promise.all([
    recreateResource(state, create, destroy),
    recreateResource(state, create, destroy),
  ]);
  assert(first === second, "concurrent callers must receive the same replacement");
  assertCount(created, 2, "one concurrent recreation must create one replacement");
  assertCount(destroyed, 1, "one concurrent recreation must destroy the old client once");

  await Promise.all([
    shutdownResource(state, destroy),
    shutdownResource(state, destroy),
  ]);
  assertCount(destroyed, 2, "concurrent shutdown must destroy the replacement once");
});

test("HMR disposal before dependency resolution never attaches an obsolete adapter", async () => {
  const lifecycle = new AdapterLifecycle<{ id: number }, { id: number }>();
  let resolveDependency: ((value: { id: number }) => void) | undefined;
  const deferred = new Promise<{ id: number }>((resolve) => resolveDependency = resolve);
  let attached = 0;
  let closed = 0;
  const pending = lifecycle.get(
    () => deferred,
    (dependency) => {
      attached += 1;
      return dependency;
    },
  );

  lifecycle.dispose((_instance) => {
    closed += 1;
    return Promise.resolve();
  });
  resolveDependency?.({ id: 1 });

  let rejected = false;
  try {
    await pending;
  } catch (error) {
    rejected = error instanceof AdapterDisposedError;
  }
  assert(rejected, "the obsolete adapter promise must reject as disposed");
  assert(attached === 0, "an obsolete module must not register an adapter or mutation listener");
  assert(closed === 0, "nothing should close when attachment never happened");
});
