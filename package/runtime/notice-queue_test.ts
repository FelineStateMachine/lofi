import { assert, assertCount } from "./test-assert.ts";
import { createMemoryJournalStorage } from "./write-journal.ts";
import { NoticeQueue } from "./notice-queue.ts";

function queue(now: () => number = () => 1000): {
  q: NoticeQueue;
  storage: ReturnType<typeof createMemoryJournalStorage>;
  counts: number[];
} {
  const storage = createMemoryJournalStorage();
  const counts: number[] = [];
  return { q: new NoticeQueue(storage, now, (count) => counts.push(count)), storage, counts };
}

Deno.test("enqueue is idempotent by id, so an at-least-once re-delivery adds one entry", async () => {
  const { q, counts } = queue();
  await q.enqueue({ id: "w1:notice#1", message: "Saved.", tone: "success", ttlMs: null });
  await q.enqueue({ id: "w1:notice#1", message: "Saved.", tone: "success", ttlMs: null });
  assertCount(q.list().length, 1, "the second enqueue with one id must be a no-op");
  assertCount(counts.at(-1) ?? -1, 1, "the active-notice count must reflect one entry");
});

Deno.test("dismiss removes one entry and notifies subscribers", async () => {
  const { q } = queue();
  let notified = 0;
  q.subscribe(() => notified += 1);
  await q.enqueue({ id: "a", message: "one", tone: "info", ttlMs: null });
  await q.enqueue({ id: "b", message: "two", tone: "info", ttlMs: null });
  q.dismiss("a");
  assertCount(q.list().length, 1, "dismiss must drop exactly the named entry");
  assert(q.list()[0].id === "b", "the surviving entry must be the one not dismissed");
  assert(notified >= 3, "each mutation must notify subscribers");
});

Deno.test("a TTL entry retires once its window closes", async () => {
  let clock = 1000;
  const { q } = queue(() => clock);
  await q.enqueue({ id: "ttl", message: "temporary", tone: "warning", ttlMs: 5000 });
  assertCount(q.list().length, 1, "the entry is live inside its window");
  clock = 6001;
  assertCount(q.list().length, 0, "list must not surface an entry past its TTL");
});

Deno.test("an entry enqueued during the load window is merged, not clobbered", async () => {
  const storage = createMemoryJournalStorage(
    JSON.stringify({
      version: 1,
      entries: [{ id: "persisted", message: "old", tone: "info", createdAt: 1, expiresAt: null }],
    }),
  );
  const q = new NoticeQueue(storage, () => 1000);
  // An effect fires at a boot re-arm and enqueues before load() resolves.
  const enqueued = q.enqueue({ id: "boot", message: "fresh", tone: "success", ttlMs: null });
  await Promise.all([q.load(), enqueued]);
  const ids = q.list().map((entry) => entry.id).sort();
  assertCount(ids.length, 2, "the boot entry and the persisted entry both survive");
  assert(ids.includes("boot") && ids.includes("persisted"), "neither entry is clobbered");
});

Deno.test("a persisted queue reloads its entries and drops expired ones", async () => {
  let clock = 1000;
  const storage = createMemoryJournalStorage();
  const first = new NoticeQueue(storage, () => clock);
  await first.enqueue({ id: "keep", message: "durable", tone: "info", ttlMs: null });
  await first.enqueue({ id: "drop", message: "fleeting", tone: "info", ttlMs: 100 });
  await first.flush();

  clock = 5000;
  const second = new NoticeQueue(storage, () => clock);
  await second.load();
  const ids = second.list().map((entry) => entry.id);
  assert(ids.includes("keep"), "a persisted entry must survive a reload");
  assert(!ids.includes("drop"), "an entry whose TTL passed while away must not reappear");
});

Deno.test("enqueue rejects a failed save and replay retries persistence", async () => {
  const saves: string[] = [];
  let attempts = 0;
  const q = new NoticeQueue({
    load: () => Promise.resolve(null),
    save(text) {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("quota"));
      saves.push(text);
      return Promise.resolve();
    },
  });
  const input = { id: "retry", message: "durable", tone: "error" as const, ttlMs: null };
  let rejected = false;
  try {
    await q.enqueue(input);
  } catch {
    rejected = true;
  }
  assert(rejected, "the effect handler must observe a failed durable save");
  await q.enqueue(input);
  assert(attempts === 2, "re-delivery must retry persistence for an in-memory duplicate");
  assert(saves[0]?.includes('"id":"retry"') === true, "the replayed entry must become durable");
});
