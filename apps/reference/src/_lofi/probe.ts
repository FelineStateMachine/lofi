import {
  getRuntime,
  getRuntimeDiagnostics,
  recreateRuntime,
  runtimeRecreatedEvent,
  shutdownRuntime,
} from "./runtime.ts";

export type ReferenceProbe = {
  diagnostics: typeof getRuntimeDiagnostics;
  create(text: string): Promise<void>;
  update(id: string, text: string): Promise<void>;
  setCompleted(id: string, completed: boolean): Promise<void>;
  delete(id: string): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  recreate(): Promise<void>;
  shutdown(): Promise<void>;
};

declare global {
  interface Window {
    __LOFI_REFERENCE__?: ReferenceProbe;
  }
}

if (typeof document !== "undefined") {
  (globalThis as typeof globalThis & Window).__LOFI_REFERENCE__ = {
    diagnostics: getRuntimeDiagnostics,
    create: async (text) => await (await getRuntime()).checklist.create(text),
    update: async (id, text) => await (await getRuntime()).checklist.update(id, text),
    setCompleted: async (id, completed) =>
      await (await getRuntime()).checklist.setCompleted(id, completed),
    delete: async (id) => await (await getRuntime()).checklist.delete(id),
    disconnect: async () => await (await getRuntime()).db.disconnect(),
    reconnect: async () => await (await getRuntime()).db.reconnect(),
    recreate: async () => {
      await recreateRuntime();
      globalThis.dispatchEvent(new Event(runtimeRecreatedEvent));
    },
    shutdown: shutdownRuntime,
  };
}
