import { createBootProgressTracker } from "./boot-progress.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function streamedResponse(chunks: readonly Uint8Array[]): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
    }),
  );
}

Deno.test("engine warm-up reports byte progress through the declared size", async () => {
  const tracker = createBootProgressTracker({
    engineAsset: () => ({ url: "https://example.com/app/_astro/jazz.wasm", bytes: 100 }),
    fetchImpl: () => Promise.resolve(streamedResponse([new Uint8Array(40), new Uint8Array(60)])),
  });
  const observed: Array<{ phase: string; loadedBytes: number; totalBytes: number | null }> = [];
  tracker.subscribe((progress) => observed.push({ ...progress }));
  assert(tracker.get().phase === "pending", "tracker must start pending");
  await tracker.warmEngineDownload();
  assert(
    observed.some((entry) =>
      entry.phase === "downloading" && entry.loadedBytes === 0 && entry.totalBytes === 100
    ),
    "download start was not published with the declared size",
  );
  assert(
    tracker.get().phase === "downloading" && tracker.get().loadedBytes === 100,
    `download completion was not published: ${JSON.stringify(tracker.get())}`,
  );
  const loadedSequence = observed.map((entry) => entry.loadedBytes);
  assert(
    loadedSequence.some((bytes) => bytes === 40),
    `intermediate progress was not published: ${JSON.stringify(loadedSequence)}`,
  );
  tracker.mark("opening");
  tracker.mark("ready");
  assert(
    tracker.get().phase === "ready" && tracker.get().loadedBytes === 100,
    "phase transitions must preserve byte progress",
  );
});

Deno.test("a shell without an engine declaration skips the download phase", async () => {
  const tracker = createBootProgressTracker({
    engineAsset: () => null,
    fetchImpl: () => {
      throw new Error("no declaration must mean no fetch");
    },
  });
  await tracker.warmEngineDownload();
  assert(tracker.get().phase === "pending", "phase must stay pending without a declaration");
  tracker.mark("opening");
  tracker.mark("ready");
  assert(tracker.get().phase === "ready", "lifecycle marks must still apply");
});

Deno.test("warm-up failures resolve silently and run once per document", async () => {
  let fetches = 0;
  const tracker = createBootProgressTracker({
    engineAsset: () => ({ url: "https://example.com/app/_astro/jazz.wasm", bytes: null }),
    fetchImpl: () => {
      fetches += 1;
      return Promise.reject(new Error("offline"));
    },
  });
  await tracker.warmEngineDownload();
  await tracker.warmEngineDownload();
  assert(fetches === 1, `warm-up must be memoized per document, saw ${fetches} fetches`);
  assert(
    tracker.get().phase === "downloading" && tracker.get().totalBytes === null,
    "an undeclared size must publish a null total",
  );
});

Deno.test("a non-OK engine response leaves resolution to the engine", async () => {
  const tracker = createBootProgressTracker({
    engineAsset: () => ({ url: "https://example.com/app/_astro/jazz.wasm", bytes: 100 }),
    fetchImpl: () => Promise.resolve(new Response("missing", { status: 404 })),
  });
  await tracker.warmEngineDownload();
  assert(
    tracker.get().loadedBytes === 0,
    "a failed download must not report progress",
  );
});
