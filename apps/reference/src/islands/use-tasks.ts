import { useCallback, useState } from "preact/hooks";
import type { RowOf, WriteHandle } from "@nzip/lofi";
import { useLiveQuery, useWrite } from "@nzip/lofi/preact";
import { s } from "@nzip/lofi/schema";
import { app } from "../app.ts";

/**
 * Author-owned example. Tables are the nouns of your app; verbs are what
 * happens to them. This module declares two verbs over the `tasks` table —
 * `addTask` carries effects that run when the write's sync fate settles, and
 * `setTaskCompleted` is a plain verb — then wraps them in a domain hook.
 * Replace `tasks` and the verbs below with your own model; framework runtime
 * code remains in `@nzip/lofi`.
 */
const tasksTable = app.schema.tasks;

/** The row type comes straight from the declared schema. */
export type Task = RowOf<typeof tasksTable>;

/**
 * The verb call sites use. Its effect units are declared once, here: the
 * consequence runs when the store confirms the task, the compensation runs if
 * a stale-policy write is denied — even if the app restarted in between.
 */
export const addTask = s.mutation("addTask", s.insert(tasksTable), {
  effects: [
    s.log("task-added"),
    s.trace("task-added"),
    s.notice<Task>({
      synced: (task) => `"${task.text ?? "Task"}" synced to your account`,
      // The engine already rolled a denied insert out of local reads; this
      // durable notice compensates what the user was told, even after reload.
      rejected: (task) => `"${task.text ?? "Task"}" was declined by the store and has been removed`,
    }),
  ],
});

/** Toggling completion is a plain verb: no consequences, same lifecycle. */
export const setTaskCompleted = s.mutation("setTaskCompleted", s.update(tasksTable));

export function useTasks() {
  const query = useLiveQuery(() => tasksTable.orderBy("createdAt", "desc"), []);
  const [lastWrite, setLastWrite] = useState<WriteHandle<Task> | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const write = useWrite(lastWrite);

  const create = useCallback((text: string) => {
    // The verb returns a WriteHandle: awaiting it means saved on this device;
    // `.synced` and the declared effects follow the store's confirmation.
    const handle = addTask({ text, completed: false, createdAt: new Date() });
    setLastWrite(handle);
    setWriteError(null);
    handle.saved.then(undefined, (error) => {
      setWriteError(error instanceof Error ? error.message : String(error));
    });
    return handle;
  }, []);
  const setCompleted = useCallback(
    (id: string, completed: boolean) => setTaskCompleted(id, { completed }),
    [],
  );

  const durability = write.stage === "synced"
    ? "global" as const
    : write.stage === "saved" || write.stage === "syncing"
    ? "local" as const
    : write.stage === "rejected"
    ? "failed" as const
    : "none" as const;

  return {
    status: query.status === "error" || writeError !== null ? "error" as const : query.status,
    error: query.error ?? writeError,
    durability,
    lastWriteStage: write.stage,
    lastWriteReason: write.reason,
    tasks: query.rows,
    failureKind: query.status === "error" ? "read" as const : "write" as const,
    create,
    setCompleted,
  };
}
