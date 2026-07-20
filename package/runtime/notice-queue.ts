/**
 * Package-owned durable notice queue: the store behind the built-in
 * `s.notice` effect unit.
 *
 * A notice is a user-visible message an effect enqueues when a write settles —
 * the durable answer to "a rejected write still flashed success". The queue is
 * deliberately not an imperative toast: an effect can fire at a boot re-arm
 * with no UI mounted, so the entry must outlive the render and be picked up
 * later. Entries persist beside the write journal (OPFS when the browser
 * provides it, `localStorage` otherwise), are keyed by the enqueuing
 * obligation's journal id so an at-least-once re-delivery adds one entry, and
 * retire by dismissal or TTL. A component (the built-in notices surface, or an
 * author's) subscribes and renders; toasts are a userland wrapper over this.
 *
 * @module
 */

import {
  createDefaultJournalStorage,
  createMemoryJournalStorage,
  type JournalStorage,
} from "./write-journal.ts";

/** How a notice is classified for rendering. */
export type NoticeTone = "info" | "success" | "warning" | "error";

/** One durable notice entry. */
export type NoticeEntry = {
  /** The enqueuing obligation's journal id — the entry's idempotency key. */
  id: string;
  /** The user-facing message. */
  message: string;
  /** The message classification. */
  tone: NoticeTone;
  /** Epoch milliseconds when the entry was enqueued. */
  createdAt: number;
  /** Epoch milliseconds when the entry retires by TTL, or `null` for none. */
  expiresAt: number | null;
};

/** The persisted queue document. */
type NoticeDocument = {
  version: 1;
  entries: NoticeEntry[];
};

function parse(text: string | null): NoticeDocument {
  if (!text) return { version: 1, entries: [] };
  try {
    const value = JSON.parse(text) as Partial<NoticeDocument> | null;
    if (value && value.version === 1 && Array.isArray(value.entries)) {
      const entries = value.entries.filter((entry): entry is NoticeEntry =>
        typeof entry?.id === "string" && typeof entry.message === "string"
      );
      return { version: 1, entries };
    }
  } catch {
    // A corrupt queue must not brick boot; start empty.
  }
  return { version: 1, entries: [] };
}

/** What one enqueue call carries, before the queue stamps identity and time. */
export type NoticeEnqueueInput = {
  /** The idempotency key — the enqueuing obligation's journal id. */
  id: string;
  /** The user-facing message. */
  message: string;
  /** The message classification. */
  tone: NoticeTone;
  /** Lifespan before TTL retirement, or `null` to keep until dismissed. */
  ttlMs: number | null;
};

/**
 * The single reader and writer of the durable notice queue: an in-memory
 * document with coalesced persistence, a live-notice snapshot, and change
 * notification. Retirement (dismissal, TTL) is applied lazily on every read
 * and on a periodic sweep, so a queue loaded at boot never surfaces a message
 * whose window already closed.
 */
export class NoticeQueue {
  readonly #storage: JournalStorage;
  readonly #now: () => number;
  #document: NoticeDocument = { version: 1, entries: [] };
  #chain: Promise<void> = Promise.resolve();
  #loaded = false;
  #loading: Promise<void> | null = null;
  #listeners = new Set<() => void>();
  #onCountChange?: (count: number) => void;

  /** Creates a queue over one storage location and clock. */
  constructor(
    storage: JournalStorage,
    now: () => number = Date.now,
    onCountChange?: (count: number) => void,
  ) {
    this.#storage = storage;
    this.#now = now;
    this.#onCountChange = onCountChange;
  }

  /**
   * Loads the persisted document once, dropping already-expired entries.
   * Entries enqueued in the async load window — an effect firing at a boot
   * re-arm before load resolves — are merged in rather than clobbered: the
   * persisted set is the base, and any in-memory entry (fresher) wins on id.
   */
  load(): Promise<void> {
    if (this.#loaded) return Promise.resolve();
    this.#loading ??= this.#load().catch((error) => {
      this.#loading = null;
      throw error;
    });
    return this.#loading;
  }

  async #load(): Promise<void> {
    const persisted = parse(await this.#storage.load());
    const pending = this.#document.entries;
    const byId = new Map<string, NoticeEntry>();
    for (const entry of persisted.entries) byId.set(entry.id, entry);
    // In-memory entries were enqueued this session and are authoritative for
    // their id; they overwrite any stale persisted copy.
    for (const entry of pending) byId.set(entry.id, entry);
    this.#document = { version: 1, entries: [...byId.values()] };
    this.#loaded = true;
    const swept = this.#sweepExpired();
    // A load that absorbed in-flight entries must re-persist the merged set
    // and publish it, so the boot-enqueued notice is not silently deferred.
    if (pending.length > 0 || swept) await this.#persist();
    this.#emit();
  }

  /**
   * Enqueues one notice, idempotent by id: an entry whose id is already
   * present is left untouched, so an at-least-once re-delivery adds nothing.
   */
  async enqueue(input: NoticeEnqueueInput): Promise<void> {
    await this.load();
    const exists = this.#document.entries.some((entry) => entry.id === input.id);
    if (!exists) {
      const createdAt = this.#now();
      this.#document.entries.push({
        id: input.id,
        message: input.message,
        tone: input.tone,
        createdAt,
        expiresAt: input.ttlMs === null ? null : createdAt + input.ttlMs,
      });
      this.#emit();
    }
    // Persist duplicate deliveries too: if the first attempt mutated memory
    // but its save failed, replay is the retry that makes the entry durable.
    await this.#persist();
  }

  /** Dismisses one entry by id; unknown ids are a no-op. */
  dismiss(id: string): void {
    const next = this.#document.entries.filter((entry) => entry.id !== id);
    if (next.length === this.#document.entries.length) return;
    this.#document.entries = next;
    void this.#persist().catch(() => undefined);
    this.#emit();
  }

  /** Dismisses every entry. */
  dismissAll(): void {
    if (this.#document.entries.length === 0) return;
    this.#document.entries = [];
    void this.#persist().catch(() => undefined);
    this.#emit();
  }

  /**
   * The live notices: enqueued, not dismissed, not past their TTL. A pure
   * read — it computes the live view without mutating stored state, so a
   * render never silently prunes the queue (which would drift the persisted
   * set and the `activeNotices` count from what a later `sweep()` sees).
   * Actual retirement of expired entries happens in {@link sweep}, which
   * persists and notifies. A fresh array each call, so callers may hold it.
   */
  list(): readonly NoticeEntry[] {
    return this.#liveEntries();
  }

  #liveEntries(): NoticeEntry[] {
    const now = this.#now();
    return this.#document.entries.filter((entry) =>
      entry.expiresAt === null || entry.expiresAt > now
    );
  }

  /** Subscribes to queue changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Resolves once every scheduled persistence has settled. */
  flush(): Promise<void> {
    return this.#chain;
  }

  /** Applies TTL retirement, persisting and notifying if anything changed. */
  sweep(): void {
    if (this.#sweepExpired()) {
      void this.#persist().catch(() => undefined);
      this.#emit();
    }
  }

  #sweepExpired(): boolean {
    const now = this.#now();
    const before = this.#document.entries.length;
    this.#document.entries = this.#document.entries.filter((entry) =>
      entry.expiresAt === null || entry.expiresAt > now
    );
    return this.#document.entries.length !== before;
  }

  #persist(): Promise<void> {
    const snapshot = JSON.stringify(this.#document);
    const attempt = this.#chain.then(() => this.#storage.save(snapshot));
    // Keep the serialized queue usable after a failed attempt while returning
    // that failure to the effect handler that requires durable delivery.
    this.#chain = attempt.catch(() => undefined);
    return attempt;
  }

  #emit(): void {
    // The count and every subscriber see the live view, so `activeNotices`
    // never overcounts entries that have expired but not yet been swept.
    this.#onCountChange?.(this.#liveEntries().length);
    for (const listener of this.#listeners) listener();
  }
}

/** Resolves the default notice-queue storage for one app id. */
export function createDefaultNoticeStorage(appId: string): JournalStorage {
  // The journal's storage resolver already picks OPFS, then localStorage, then
  // memory; a distinct file name keeps the two documents apart.
  return createDefaultJournalStorage(`notices-${appId}`);
}

/** An in-memory notice queue for tests and storage-less runtimes. */
export function createMemoryNoticeQueue(now?: () => number): NoticeQueue {
  return new NoticeQueue(createMemoryJournalStorage(), now);
}
