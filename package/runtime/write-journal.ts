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
 * The journal never stores column values. Boot-reconciliation equality probes
 * compare per-column keyed hashes (HMAC-SHA-256 under a random per-journal
 * key), so the journal is not a second greppable plaintext copy of row data.
 * This does not protect low-entropy values against brute force by an attacker
 * holding the whole storage — that attacker's access already equals the local
 * store's own at-rest posture.
 *
 * @module
 */

import { sha256 } from "@noble/hashes/sha2";

/**
 * One obligation's durable status. `pending` until the handler completes;
 * `failed` handlers re-arm at boot until quarantine retires them as
 * `failed-permanent`; `expired` marks a delivery window that closed before
 * the obligation could be delivered. Retired statuses never run again and
 * make the entry prunable.
 */
export type JournalEffectStatus =
  | "pending"
  | "done"
  | "failed"
  | "expired"
  | "failed-permanent";

/** One effect obligation's durable state within a journaled write. */
export type JournalEffectState = {
  /** The obligation's durable status. */
  status: JournalEffectStatus;
  /** How many times the handler has been started, across reloads. */
  attempts: number;
  /** The last handler failure message, for diagnostics. */
  lastError: string | null;
  /** Epoch milliseconds when the delivery window closes, or `null` for none. */
  expiresAt: number | null;
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
   * Keyed per-column hashes of the written values (all columns for inserts,
   * the changed columns for updates, none for removes), sufficient for the
   * boot-reconciliation equality probe. Values themselves are never stored.
   */
  rowHashes: Record<string, string>;
  /** The write's durable fate so far. */
  stage: JournalWriteStage;
  /** The structured rejection cause, when the stage is `rejected`. */
  cause: "denied" | "expired" | null;
  /** The adjudicated rejection code, when the stage is `rejected`. */
  code: string | null;
  /** The adjudicated rejection reason, when the stage is `rejected`. */
  reason: string | null;
  /** Epoch milliseconds when the write was journaled. */
  createdAt: number;
  /** Epoch milliseconds when the intent's lifespan ends, or `null` for none. */
  expiresAt: number | null;
  /** Effect obligations keyed by effect name. */
  effects: Record<string, JournalEffectState>;
};

/** The persisted journal document. */
export type JournalDocument = {
  /** Storage format version. */
  version: 1;
  /** The random per-journal key (hex) the column-value hashes are keyed with. */
  hashKey: string;
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

function randomHashKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** An empty journal document with a freshly generated hash key. */
export function emptyJournal(): JournalDocument {
  return { version: 1, hashKey: randomHashKey(), writes: {} };
}

// One HMAC-SHA-256 block; noble's sha256 keeps this synchronous, so hashes
// exist before the journal entry is first persisted.
function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64;
  const normalizedKey = key.length > blockSize ? sha256(key) : key;
  const inner = new Uint8Array(blockSize).fill(0x36);
  const outer = new Uint8Array(blockSize).fill(0x5c);
  for (let index = 0; index < normalizedKey.length; index += 1) {
    inner[index] ^= normalizedKey[index];
    outer[index] ^= normalizedKey[index];
  }
  const message1 = new Uint8Array(blockSize + message.length);
  message1.set(inner);
  message1.set(message, blockSize);
  const innerHash = sha256(message1);
  const message2 = new Uint8Array(blockSize + innerHash.length);
  message2.set(outer);
  message2.set(innerHash, blockSize);
  return sha256(message2);
}

function hexKeyBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length >> 1);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * The keyed hash of one JSON-normalized column value under a journal's hash
 * key: what the journal persists instead of the value, and what the
 * boot-reconciliation probe computes over live rows for the equality check.
 */
export function hashJournalValue(hashKey: string, value: unknown): string {
  const canonical = JSON.stringify(value === undefined ? null : value) ?? "null";
  const digest = hmacSha256(hexKeyBytes(hashKey), new TextEncoder().encode(canonical));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Parses persisted journal text; unreadable or foreign text is an empty
 * journal. Entries from earlier formats without column hashes are dropped, so
 * no plaintext-era record survives a load.
 */
export function parseJournal(text: string | null): JournalDocument {
  if (!text) return emptyJournal();
  try {
    const value = JSON.parse(text) as Partial<JournalDocument> | null;
    if (
      value && value.version === 1 && typeof value.hashKey === "string" && value.hashKey &&
      value.writes && typeof value.writes === "object"
    ) {
      const writes: Record<string, JournalWriteRecord> = {};
      for (const [writeId, entry] of Object.entries(value.writes)) {
        const record = entry as Partial<JournalWriteRecord>;
        if (!record.rowHashes || typeof record.rowHashes !== "object") continue;
        writes[writeId] = entry as JournalWriteRecord;
      }
      return { version: 1, hashKey: value.hashKey, writes };
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
