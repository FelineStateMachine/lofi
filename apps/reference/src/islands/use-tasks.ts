import { useCallback, useEffect, useState } from "preact/hooks";
import { schema as s } from "jazz-tools";
import { getRuntime, runtimeRecreatedEvent, type TableSnapshot } from "@nzip/lofi";
import { app } from "../app.ts";

/**
 * Author-owned example. This is the whole binding between a declared table and
 * the UI: pick a table from your schema, derive its row type, and wrap the
 * generic store's writes in domain verbs. Replace `tasks` and the methods below
 * with your own model — framework runtime code remains in `@nzip/lofi`.
 */
const tasksTable = app.schema.tasks;

/** Row and insert types come straight from the declared schema. */
export type Task = s.RowOf<typeof tasksTable>;

const initial: TableSnapshot<Task> = {
  status: "loading",
  rows: [],
  durability: "none",
  error: null,
};

export function useTasks() {
  const [snapshot, setSnapshot] = useState(initial);
  const [startupFailed, setStartupFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let connectionGeneration = 0;
    let unsubscribe: (() => void) | undefined;
    // The local-first account opens immediately, so this only reconnects when the
    // runtime is recreated — e.g. after electing to sync or restoring an account,
    // both of which dispatch `runtimeRecreatedEvent`.
    const connect = () => {
      const generation = ++connectionGeneration;
      unsubscribe?.();
      unsubscribe = undefined;
      setSnapshot(initial);
      setStartupFailed(false);
      void getRuntime().then((runtime) => {
        if (cancelled || generation !== connectionGeneration) return;
        const store = runtime.store(tasksTable);
        const update = () => setSnapshot(store.getSnapshot());
        unsubscribe = store.subscribe(update);
        update();
      }, (error) => {
        if (cancelled || generation !== connectionGeneration) return;
        setStartupFailed(true);
        setSnapshot({
          ...initial,
          status: "error",
          durability: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
    connect();
    globalThis.addEventListener(runtimeRecreatedEvent, connect);
    return () => {
      cancelled = true;
      connectionGeneration += 1;
      globalThis.removeEventListener(runtimeRecreatedEvent, connect);
      unsubscribe?.();
    };
  }, []);

  // The generic store also exposes `update` (for edits) and `delete`; this
  // starter only needs insert and a boolean toggle. Add more verbs as you grow.
  const store = useCallback(async () => (await getRuntime()).store(tasksTable), []);
  const create = useCallback(async (text: string) => {
    await (await store()).insert({ text, completed: false, createdAt: new Date() });
  }, [store]);
  const setCompleted = useCallback(async (id: string, completed: boolean) => {
    await (await store()).update(id, { completed });
  }, [store]);

  return {
    ...snapshot,
    tasks: snapshot.rows,
    failureKind: startupFailed ? "startup" as const : "write" as const,
    create,
    setCompleted,
  };
}
