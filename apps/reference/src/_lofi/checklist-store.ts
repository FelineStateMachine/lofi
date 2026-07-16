import type { Db, MutationErrorEvent } from "jazz-tools";
import { referenceApp } from "../app.ts";
import { serverUrl } from "./config.ts";

export type ChecklistTask = {
  id: string;
  text: string;
  completed: boolean;
  createdAt: Date;
};

export type ChecklistSnapshot = {
  status: "loading" | "ready" | "error";
  tasks: ChecklistTask[];
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
  pendingLocalWrites: number;
  pendingGlobalWrites: number;
  lastWriteDurability: "none" | "local" | "global" | "failed";
  mutationErrors: number;
};

type Listener = () => void;
type MutationHandle = {
  wait(options: { tier: "local" | "global" }): Promise<unknown>;
};

export class ChecklistStore {
  readonly #db: Db;
  readonly #diagnostics: RuntimeDiagnostics;
  readonly #syncConfigured: boolean;
  readonly #diagnosticsChanged: () => void;
  readonly #listeners = new Set<Listener>();
  #vendorUnsubscribe: (() => void) | null = null;
  #writeGeneration = 0;
  #snapshot: ChecklistSnapshot = {
    status: "loading",
    tasks: [],
    durability: "none",
    error: null,
  };

  constructor(
    db: Db,
    diagnostics: RuntimeDiagnostics,
    syncConfigured = Boolean(serverUrl),
    diagnosticsChanged: () => void = () => undefined,
  ) {
    this.#db = db;
    this.#diagnostics = diagnostics;
    this.#syncConfigured = syncConfigured;
    this.#diagnosticsChanged = diagnosticsChanged;
  }

  getSnapshot = (): ChecklistSnapshot => this.#snapshot;

  subscribe = (listener: Listener): () => void => {
    this.#listeners.add(listener);
    this.#diagnostics.activeConsumers = this.#listeners.size;
    this.#diagnosticsChanged();
    if (this.#listeners.size === 1) this.#openVendorSubscription();
    this.#emit();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
      this.#diagnostics.activeConsumers = this.#listeners.size;
      this.#diagnosticsChanged();
      if (this.#listeners.size === 0) this.#closeVendorSubscription();
      else this.#emit();
    };
  };

  async create(text: string): Promise<void> {
    const now = new Date();
    await this.#settle(this.#db.insert(referenceApp.schema.tasks, {
      text,
      completed: false,
      createdAt: now,
    }));
  }

  async update(id: string, text: string): Promise<void> {
    await this.#settle(
      this.#db.update(referenceApp.schema.tasks, id, { text }),
    );
  }

  async setCompleted(id: string, completed: boolean): Promise<void> {
    await this.#settle(
      this.#db.update(referenceApp.schema.tasks, id, { completed }),
    );
  }

  async delete(id: string): Promise<void> {
    await this.#settle(this.#db.delete(referenceApp.schema.tasks, id));
  }

  reportMutationError(event: MutationErrorEvent): void {
    this.#diagnostics.mutationErrors += 1;
    this.#diagnosticsChanged();
    this.#fail(new Error(`${event.code}: ${event.reason}`));
  }

  close(): void {
    this.#listeners.clear();
    this.#diagnostics.activeConsumers = 0;
    this.#diagnosticsChanged();
    this.#closeVendorSubscription();
  }

  async #settle(mutation: MutationHandle): Promise<void> {
    const generation = ++this.#writeGeneration;
    let localPending = true;
    this.#diagnostics.pendingLocalWrites += 1;
    this.#diagnosticsChanged();
    this.#set({ status: "ready", durability: "none", error: null });
    try {
      await mutation.wait({ tier: "local" });
      localPending = false;
      this.#diagnostics.pendingLocalWrites -= 1;
      this.#diagnostics.localWaitCalls += 1;
      this.#diagnosticsChanged();
      if (generation === this.#writeGeneration) {
        this.#set({ durability: "local", error: null });
      }
      if (this.#syncConfigured) {
        this.#diagnostics.pendingGlobalWrites += 1;
        this.#diagnosticsChanged();
        void mutation.wait({ tier: "global" }).then(
          () => {
            if (generation === this.#writeGeneration) {
              this.#set({ durability: "global", error: null });
            }
          },
          (error) => {
            this.#diagnostics.mutationErrors += 1;
            this.#diagnosticsChanged();
            this.#fail(error);
          },
        ).finally(() => {
          this.#diagnostics.pendingGlobalWrites -= 1;
          this.#diagnosticsChanged();
        });
      }
    } catch (error) {
      if (localPending) this.#diagnostics.pendingLocalWrites -= 1;
      this.#diagnostics.mutationErrors += 1;
      this.#diagnosticsChanged();
      this.#fail(error);
      throw error;
    }
  }

  #openVendorSubscription(): void {
    if (this.#vendorUnsubscribe) return;
    try {
      this.#vendorUnsubscribe = this.#db.subscribeAll(referenceApp.schema.tasks, (delta) => {
        this.#snapshot = {
          ...this.#snapshot,
          status: "ready",
          tasks: delta.all as ChecklistTask[],
          error: null,
        };
        this.#emit();
      });
      this.#diagnostics.activeVendorSubscriptions += 1;
      this.#diagnostics.totalVendorSubscriptions += 1;
      this.#diagnosticsChanged();
    } catch (error) {
      this.#fail(error);
    }
  }

  #closeVendorSubscription(): void {
    if (!this.#vendorUnsubscribe) return;
    this.#vendorUnsubscribe();
    this.#diagnostics.unsubscribeCalls += 1;
    this.#vendorUnsubscribe = null;
    this.#diagnostics.activeVendorSubscriptions -= 1;
    this.#diagnosticsChanged();
  }

  #set(change: Partial<ChecklistSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    if (change.durability) {
      this.#diagnostics.lastWriteDurability = change.durability;
      this.#diagnosticsChanged();
    }
    this.#emit();
  }

  #fail(error: unknown): void {
    this.#snapshot = {
      ...this.#snapshot,
      status: "error",
      durability: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
    this.#diagnostics.lastWriteDurability = "failed";
    this.#diagnosticsChanged();
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
