import { useCallback } from "preact/hooks";
import { schema as s } from "jazz-tools";
import { useLiveQuery, useTableMutations } from "@nzip/lofi/preact";
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

export function useTasks() {
  const query = useLiveQuery(() => tasksTable.orderBy("createdAt", "desc"), []);
  const mutations = useTableMutations(tasksTable);

  // The generic mutation surface also exposes `remove`; this starter only needs
  // insert and a boolean toggle. Add more domain verbs as you grow.
  const create = useCallback(async (text: string) => {
    await mutations.insert({ text, completed: false, createdAt: new Date() });
  }, [mutations.insert]);
  const setCompleted = useCallback(async (id: string, completed: boolean) => {
    await mutations.update(id, { completed });
  }, [mutations.update]);

  const mutationFailed = mutations.error !== null;

  return {
    status: query.status === "error" || mutationFailed ? "error" as const : query.status,
    error: query.error ?? mutations.error,
    durability: mutations.durability,
    tasks: query.rows,
    failureKind: query.status === "error" ? "read" as const : "write" as const,
    create,
    setCompleted,
  };
}
