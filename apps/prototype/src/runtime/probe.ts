import {
  getRuntime,
  getRuntimeDiagnostics,
  recreateRuntime,
  runtimeRecreatedEvent,
  shutdownRuntime,
} from "./lofi-runtime.ts";

export type PrototypeProbe = {
  diagnostics: typeof getRuntimeDiagnostics;
  add(body: string): Promise<void>;
  update(id: string, body: string): Promise<void>;
  recreate(): Promise<void>;
  shutdown(): Promise<void>;
};

declare global {
  interface Window {
    __LOFI_PROTOTYPE__?: PrototypeProbe;
  }
}

if (typeof document !== "undefined") {
  (globalThis as typeof globalThis & Window).__LOFI_PROTOTYPE__ = {
    diagnostics: getRuntimeDiagnostics,
    add: async (body) => await (await getRuntime()).notes.add(body),
    update: async (id, body) => await (await getRuntime()).notes.update(id, body),
    recreate: async () => {
      await recreateRuntime();
      globalThis.dispatchEvent(new Event(runtimeRecreatedEvent));
    },
    shutdown: shutdownRuntime,
  };
}
