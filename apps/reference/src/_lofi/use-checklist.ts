import { useCallback, useEffect, useState } from "preact/hooks";
import type { ChecklistSnapshot } from "./checklist-store.ts";
import { getRuntime, runtimeRecreatedEvent } from "./runtime.ts";

const initial: ChecklistSnapshot = {
  status: "loading",
  tasks: [],
  durability: "none",
  error: null,
};

export function useChecklist() {
  const [snapshot, setSnapshot] = useState(initial);

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
        const update = () => setSnapshot(runtime.checklist.getSnapshot());
        unsubscribe = runtime.checklist.subscribe(update);
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

  const create = useCallback(async (text: string) => {
    await (await getRuntime()).checklist.create(text);
  }, []);
  const update = useCallback(async (id: string, text: string) => {
    await (await getRuntime()).checklist.update(id, text);
  }, []);
  const setCompleted = useCallback(async (id: string, completed: boolean) => {
    await (await getRuntime()).checklist.setCompleted(id, completed);
  }, []);
  const remove = useCallback(async (id: string) => {
    await (await getRuntime()).checklist.delete(id);
  }, []);

  return { ...snapshot, create, update, setCompleted, remove };
}
