import { useCallback, useEffect, useState } from "preact/hooks";
import { getRuntime, getRuntimeDiagnostics, runtimeRecreatedEvent } from "./lofi-runtime.ts";
import type { NotesSnapshot, RuntimeDiagnostics } from "./notes-store.ts";

const initial: NotesSnapshot = {
  status: "loading",
  notes: [],
  durability: "none",
  error: null,
};

export function useNotes() {
  const [snapshot, setSnapshot] = useState(initial);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics>(getRuntimeDiagnostics());

  useEffect(() => {
    let cancelled = false;
    let connectionGeneration = 0;
    let unsubscribe: (() => void) | undefined;
    const connect = () => {
      const generation = ++connectionGeneration;
      unsubscribe?.();
      unsubscribe = undefined;
      setSnapshot(initial);
      void getRuntime().then((runtime) => {
        if (cancelled || generation !== connectionGeneration) return;
        const update = () => {
          setSnapshot(runtime.notes.getSnapshot());
          setDiagnostics(getRuntimeDiagnostics());
        };
        unsubscribe = runtime.notes.subscribe(update);
        update();
      }, (error) => {
        if (cancelled || generation !== connectionGeneration) return;
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

  const add = useCallback(async (body: string) => {
    const runtime = await getRuntime();
    await runtime.notes.add(body);
  }, []);

  const update = useCallback(async (id: string, body: string) => {
    const runtime = await getRuntime();
    await runtime.notes.update(id, body);
  }, []);

  return { ...snapshot, diagnostics, add, update };
}
