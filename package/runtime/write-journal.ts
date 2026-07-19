/**
 * Package-owned durable write journal.
 *
 * The substrate of the effect system: one device-local record per write,
 * persisting enough to rebuild pending sync state and outstanding effect
 * obligations after a reload. The journal lives beside the runtime's
 * persistent storage — OPFS when the browser provides it, `localStorage`
 * otherwise — and is readable at boot before sync connects. Entries are keyed
 * by write id; effect obligations are keyed by `(write id, effect name)`, and
 * the composed journal id is the idempotency key handlers receive.
 *
 * @module
 */

/** One effect obligation's durable state within a journaled write. */
export type JournalEffectState = {
  /** `pending` until the handler completes; `failed` handlers re-arm at boot. */
  status: "pending" | "done" | "failed";
  /** How many times the handler has been started, across reloads. */
  attempts: number;
  /** The last handler failure message, for diagnostics. */
  lastError: string | null;
};

/** The durable fate of a journaled write. */
export type JournalWriteStage = "saved" | "synced" | "rejected";

/** One journaled write: identity, snapshot, fate, and effect obligations. */
export type JournalWriteRecord = {
  /** The stable package-owned write id. */
  writeId: string;
  /** The declaring verb's name, or `null` for writes without a verb. */
  verb: string | null;
  /** The written table's name. */
  table: string;
  /** Which operation the write performed. */
  op: "insert" | "update" | "remove";
  /** The written row's id. */
  rowId: string;
  /** The vendor batch id used to attribute adjudicated verdicts. */
  batchId: string | null;
  /**
   * The journaled row snapshot handlers receive: the full row for inserts,
   * the id plus changed columns for updates, and the id for removes.
   */
  row: Record<string, unknown>;
  /** The write's durable fate so far. */
  stage: JournalWriteStage;
  /** The adjudicated rejection code, when the stage is `rejected`. */
  code: string | null;
  /** The adjudicated rejection reason, when the stage is `rejected`. */
  reason: string | null;
  /** Epoch milliseconds when the write was journaled. */
  createdAt: number;
  /** Effect obligations keyed by effect name. */
  effects: Record<string, JournalEffectState>;
};

/** The persisted journal document. */
export type JournalDocument = {
  /** Storage format version. */
  version: 1;
  /** Journaled writes keyed by write id. */
  writes: Record<string, JournalWriteRecord>;
};

/**
 * Where the journal document persists. The default resolves OPFS, then
 * `localStorage`, then memory; tests inject a deterministic implementation.
 */
export type JournalStorage = {
  /** Reads the persisted document text, or `null` when none exists. */
  load(): Promise<string | null>;
  /** Replaces the persisted document text. */
  save(text: string): Promise<void>;
};

/** The composed idempotency key for one `(write id, effect name)` obligation. */
export function journalIdFor(writeId: string, effectName: string): string {
  return `${writeId}:${effectName}`;
}

/** An empty journal document. */
export function emptyJournal(): JournalDocument {
  return { version: 1, writes: {} };
}

/** Parses persisted journal text; unreadable or foreign text is an empty journal. */
export function parseJournal(text: string | null): JournalDocument {
  if (!text) return emptyJournal();
  try {
    const value = JSON.parse(text) as Partial<JournalDocument> | null;
    if (value && value.version === 1 && value.writes && typeof value.writes === "object") {
      return { version: 1, writes: value.writes as Record<string, JournalWriteRecord> };
    }
  } catch {
    // Fall through: a corrupt journal must not brick boot.
  }
  return emptyJournal();
}

/** An in-memory {@link JournalStorage} for tests and storage-less runtimes. */
export function createMemoryJournalStorage(initial: string | null = null): JournalStorage & {
  /** The currently persisted text, for assertions. */
  text(): string | null;
} {
  let stored = initial;
  return {
    load: () => Promise.resolve(stored),
    save(text: string) {
      stored = text;
      return Promise.resolve();
    },
    text: () => stored,
  };
}

type OpfsDirectory = {
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<{
    getFile(): Promise<{ text(): Promise<string> }>;
    createWritable(): Promise<{ write(text: string): Promise<void>; close(): Promise<void> }>;
  }>;
};

function opfsStorage(fileName: string): JournalStorage | null {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage as
    | { getDirectory?: () => Promise<OpfsDirectory> }
    | undefined;
  if (typeof storage?.getDirectory !== "function") return null;
  const directory = () => storage.getDirectory!();
  return {
    async load() {
      try {
        const handle = await (await directory()).getFileHandle(fileName);
        return await (await handle.getFile()).text();
      } catch {
        return null;
      }
    },
    async save(text: string) {
      const handle = await (await directory()).getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    },
  };
}

function localStorageStorage(key: string): JournalStorage | null {
  if (typeof localStorage === "undefined") return null;
  return {
    load() {
      try {
        return Promise.resolve(localStorage.getItem(key));
      } catch {
        return Promise.resolve(null);
      }
    },
    save(text: string) {
      try {
        localStorage.setItem(key, text);
      } catch {
        // A private-mode quota failure degrades to session-only pending state.
      }
      return Promise.resolve();
    },
  };
}

/**
 * Resolves the default journal storage for one app id: an OPFS file when the
 * browser provides it, `localStorage` otherwise, and memory as a last resort,
 * so the journal is always readable at boot before sync connects.
 */
export function createDefaultJournalStorage(appId: string): JournalStorage {
  return opfsStorage(`lofi-write-journal-${appId}.json`) ??
    localStorageStorage(`lofi:write-journal:${appId}`) ??
    createMemoryJournalStorage();
}

/**
 * The journal's single reader and writer: an in-memory document with
 * serialized, coalesced persistence. Mutations apply synchronously in memory;
 * `flush()` awaits the trailing persisted state.
 */
export class WriteJournal {
  readonly #storage: JournalStorage;
  #document: JournalDocument = emptyJournal();
  #chain: Promise<void> = Promise.resolve();
  #loaded = false;

  /** Creates a journal over one storage location. */
  constructor(storage: JournalStorage) {
    this.#storage = storage;
  }

  /** Loads the persisted document once; later calls return the memory state. */
  async load(): Promise<JournalDocument> {
    if (!this.#loaded) {
      this.#document = parseJournal(await this.#storage.load());
      this.#loaded = true;
    }
    return this.#document;
  }

  /** The current in-memory document. */
  get document(): JournalDocument {
    return this.#document;
  }

  /** Applies one mutation to the document and schedules persistence. */
  update(mutate: (document: JournalDocument) => void): void {
    mutate(this.#document);
    const snapshot = JSON.stringify(this.#document);
    this.#chain = this.#chain
      .then(() => this.#storage.save(snapshot))
      .catch(() => undefined);
  }

  /** Resolves once every scheduled persistence has settled. */
  flush(): Promise<void> {
    return this.#chain;
  }
}
