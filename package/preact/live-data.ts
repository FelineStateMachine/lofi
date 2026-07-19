import type { QueryBuilder, TableProxy } from "jazz-tools";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  acquireLiveQuery,
  type LiveQuerySnapshot,
  type LiveQueryStore,
} from "../runtime/live-query-store.ts";
import {
  acquireTableMutations,
  type TableMutationSnapshot,
  type TableMutationStore,
} from "../runtime/table-mutations.ts";
import type { TableRow } from "../runtime/table-store.ts";
import type { WriteHandle } from "../runtime/write-handle.ts";

const loading = <T extends TableRow>(): LiveQuerySnapshot<T> => ({
  status: "loading",
  rows: [],
  error: null,
});

/**
 * Subscribes a Preact component to any typed Jazz query.
 *
 * Equivalent mounted queries share one Jazz subscription. The snapshot preserves
 * the exact row type produced by the builder, including `select` and `include`
 * projections. An empty `rows` array with `status: "ready"` is an empty result,
 * not a loading signal.
 *
 * @example
 * ```ts
 * import { useLiveQuery } from "@nzip/lofi/preact";
 * import { app } from "../app.ts";
 *
 * const records = useLiveQuery(
 *   () => app.schema.records.where({ workspaceId, archived: false }),
 *   [workspaceId],
 * );
 * // records.status is "loading" | "ready" | "error"; records.rows is typed.
 * ```
 *
 * @param createQuery Builds the typed Jazz query; re-invoked when dependencies change.
 * @param dependencies Values that, when changed, release the query and open a replacement.
 * @returns The live snapshot: `status`, exact typed `rows`, and `error`.
 */
export function useLiveQuery<T extends TableRow>(
  createQuery: () => QueryBuilder<T>,
  dependencies: readonly unknown[],
): LiveQuerySnapshot<T> {
  const [snapshot, setSnapshot] = useState<LiveQuerySnapshot<T>>(loading);
  useEffect(() => {
    setSnapshot(loading());
    try {
      const lease = acquireLiveQuery(createQuery());
      const update = () => setSnapshot(lease.store.getSnapshot());
      const unsubscribe = lease.store.subscribe(update);
      update();
      return () => {
        unsubscribe();
        lease.release();
      };
    } catch (error) {
      setSnapshot({
        status: "error",
        rows: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, dependencies);
  return snapshot;
}

/** Typed mutation methods plus their shared table-scoped observable state. */
export type TableMutations<T extends TableRow, Init> = TableMutationSnapshot & {
  insert(values: Init): WriteHandle<T>;
  update(id: string, patch: Partial<Init>): WriteHandle<void>;
  remove(id: string): WriteHandle<void>;
};

/**
 * Binds one typed Jazz table to stable insert, update, and remove methods.
 *
 * Each method returns a thenable `WriteHandle`: awaiting it resolves after
 * local durability, and the handle's `saved` and `synced` promises track the
 * write's sync fate. When managed sync is active, global confirmation
 * continues in the background and updates the shared table-scoped `pending`,
 * `durability`, and `error` state.
 *
 * @example
 * ```ts
 * import { useTableMutations } from "@nzip/lofi/preact";
 * import { app } from "../app.ts";
 *
 * const records = useTableMutations(app.schema.records);
 * const created = await records.insert({ title: "Release notes", archived: false });
 * await records.update(created.id, { archived: true });
 * await records.remove(created.id);
 * ```
 *
 * @param table The typed schema table to mutate, e.g. `app.schema.records`.
 * @returns Stable `insert`, `update`, and `remove` methods plus the shared mutation state.
 */
export function useTableMutations<T extends TableRow, Init>(
  table: TableProxy<T, Init>,
): TableMutations<T, Init> {
  const [snapshot, setSnapshot] = useState<TableMutationSnapshot>({
    pending: 0,
    durability: "none",
    error: null,
  });
  const store = useRef<TableMutationStore<T, Init> | null>(null);
  useEffect(() => {
    const lease = acquireTableMutations(table);
    store.current = lease.store;
    const update = () => setSnapshot(lease.store.getSnapshot());
    const unsubscribe = lease.store.subscribe(update);
    update();
    return () => {
      if (store.current === lease.store) store.current = null;
      unsubscribe();
      lease.release();
    };
  }, [table]);

  const requireStore = useCallback((): TableMutationStore<T, Init> => {
    if (!store.current) throw new Error("table mutations are not mounted yet");
    return store.current;
  }, []);
  const insert = useCallback((values: Init) => requireStore().insert(values), [requireStore]);
  const update = useCallback(
    (id: string, patch: Partial<Init>) => requireStore().update(id, patch),
    [requireStore],
  );
  const remove = useCallback((id: string) => requireStore().remove(id), [requireStore]);
  return { ...snapshot, insert, update, remove };
}

// Keep the exact store type reachable in generated declaration output without
// asking application authors to import implementation modules.
export type { LiveQuerySnapshot, LiveQueryStore, TableMutationSnapshot, TableMutationStore };
