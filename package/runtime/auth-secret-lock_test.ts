import {
  type AuthSecretLockManager,
  authSecretLockName,
  withAuthSecretLock,
} from "./auth-secret-lock.ts";
import { assert } from "./test-assert.ts";

// An in-memory exclusive lock manager: requests on one name run one at a
// time, in arrival order, like tabs on one origin.
function memoryLocks(): AuthSecretLockManager {
  const queues = new Map<string, Promise<unknown>>();
  return {
    request(name, _options, callback) {
      const previous = queues.get(name) ?? Promise.resolve();
      const run = previous.then(() => callback(undefined));
      queues.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

// A store with the vendor's first-visit shape: a non-atomic check-then-write
// that yields between the check and the write, so unserialized concurrent
// callers mint rival secrets.
function checkThenWriteStore() {
  const state = { stored: null as string | null, minted: 0, active: 0, overlapped: false };
  return {
    state,
    async getOrCreate(): Promise<string> {
      state.active += 1;
      if (state.active > 1) state.overlapped = true;
      const checked = state.stored;
      await new Promise((resolve) => setTimeout(resolve, 1));
      let value = checked;
      if (value === null) {
        state.minted += 1;
        value = `secret-${state.minted}`;
        state.stored = value;
      }
      state.active -= 1;
      return value;
    },
  };
}

Deno.test("concurrent first-boot creations serialize to one secret", async () => {
  const locks = memoryLocks();
  const store = checkThenWriteStore();
  const [first, second] = await Promise.all([
    withAuthSecretLock("app-1", store.getOrCreate, locks),
    withAuthSecretLock("app-1", store.getOrCreate, locks),
  ]);
  assert(!store.state.overlapped, "secret-store operations overlapped under the lock");
  assert(store.state.minted === 1, `expected one minted secret, received ${store.state.minted}`);
  assert(first === "secret-1" && second === "secret-1", "tabs resolved different secrets");
});

Deno.test("unserialized check-then-write mints rival secrets (control)", async () => {
  const store = checkThenWriteStore();
  const [first, second] = await Promise.all([store.getOrCreate(), store.getOrCreate()]);
  assert(store.state.minted === 2, "control run was expected to race");
  assert(first !== second, "control run was expected to mint rival secrets");
});

Deno.test("without a lock manager the operation runs directly", async () => {
  const store = checkThenWriteStore();
  const secret = await withAuthSecretLock("app-1", store.getOrCreate, undefined);
  assert(secret === "secret-1", "fallback path did not run the operation");
});

Deno.test("lock names are app-scoped and normalized", () => {
  assert(authSecretLockName("demo.app/1") === "lofi-auth-secret-demo-app-1", "unexpected name");
  assert(
    authSecretLockName("a") !== authSecretLockName("b"),
    "different apps must not share a lock",
  );
  assert(authSecretLockName("") === "lofi-auth-secret-app", "empty app id needs a stable name");
});
