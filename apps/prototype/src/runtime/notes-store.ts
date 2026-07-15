import type { Db, MutationErrorEvent } from "jazz-tools";
import { app } from "../schema.ts";
import { serverUrl } from "./config.ts";

export type Note = { id: string; body: string; createdAt: Date };
export type NotesSnapshot = {
  status: "loading" | "ready" | "error";
  notes: Note[];
  durability: "none" | "local" | "global" | "failed";
  error: string | null;
};

export type RuntimeDiagnostics = {
  storageState: "persistent-requested" | "persistent-driver-open" | "failed";
  clientsCreated: number;
  activeClients: number;
  activeConsumers: number;
  activeVendorSubscriptions: number;
  totalVendorSubscriptions: number;
  activeMutationListeners: number;
  totalMutationListeners: number;
  unsubscribeCalls: number;
  localWaitCalls: number;
  mutationErrors: number;
};

type Listener = () => void;

export class NotesStore {
  readonly #db: Db;
  readonly #diagnostics: RuntimeDiagnostics;
  readonly #listeners = new Set<Listener>();
  #vendorUnsubscribe: (() => void) | null = null;
  #snapshot: NotesSnapshot = {
    status: "loading",
    notes: [],
    durability: "none",
    error: null,
  };

  constructor(db: Db, diagnostics: RuntimeDiagnostics) {
    this.#db = db;
    this.#diagnostics = diagnostics;
  }

  getSnapshot = (): NotesSnapshot => this.#snapshot;

  subscribe = (listener: Listener): () => void => {
    this.#listeners.add(listener);
    this.#diagnostics.activeConsumers = this.#listeners.size;
    if (this.#listeners.size === 1) this.#openVendorSubscription();
    this.#emit();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
      this.#diagnostics.activeConsumers = this.#listeners.size;
      if (this.#listeners.size === 0) this.#closeVendorSubscription();
      else this.#emit();
    };
  };

  async add(body: string): Promise<void> {
    const write = this.#db.insert(app.notes, { body, createdAt: new Date() });
    try {
      await write.wait({ tier: "local" });
      this.#diagnostics.localWaitCalls += 1;
      this.#set({ durability: "local", error: null });
      if (serverUrl) {
        void write.wait({ tier: "global" }).then(
          () => this.#set({ durability: "global", error: null }),
          (error) => this.#fail(error),
        );
      }
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async update(id: string, body: string): Promise<void> {
    try {
      await this.#db.update(app.notes, id, { body }).wait({ tier: "local" });
      this.#diagnostics.localWaitCalls += 1;
      this.#set({ durability: "local", error: null });
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  reportMutationError(event: MutationErrorEvent) {
    this.#diagnostics.mutationErrors += 1;
    this.#fail(new Error(`${event.code}: ${event.reason}`));
  }

  close() {
    this.#listeners.clear();
    this.#diagnostics.activeConsumers = 0;
    this.#closeVendorSubscription();
  }

  #openVendorSubscription() {
    if (this.#vendorUnsubscribe) return;
    try {
      this.#vendorUnsubscribe = this.#db.subscribeAll(app.notes, (delta) => {
        this.#snapshot = {
          ...this.#snapshot,
          status: "ready",
          notes: delta.all as Note[],
          error: null,
        };
        this.#emit();
      });
      this.#diagnostics.activeVendorSubscriptions += 1;
      this.#diagnostics.totalVendorSubscriptions += 1;
    } catch (error) {
      this.#fail(error);
    }
  }

  #closeVendorSubscription() {
    if (!this.#vendorUnsubscribe) return;
    this.#vendorUnsubscribe();
    this.#diagnostics.unsubscribeCalls += 1;
    this.#vendorUnsubscribe = null;
    this.#diagnostics.activeVendorSubscriptions -= 1;
  }

  #set(change: Partial<NotesSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...change };
    this.#emit();
  }

  #fail(error: unknown) {
    this.#snapshot = {
      ...this.#snapshot,
      status: "error",
      durability: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
    this.#emit();
  }

  #emit() {
    for (const listener of this.#listeners) listener();
  }
}
