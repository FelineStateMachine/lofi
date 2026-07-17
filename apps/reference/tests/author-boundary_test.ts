const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

const authorUiFiles = [
  new URL("../src/pages/index.astro", import.meta.url),
  new URL("../src/islands/TaskList.tsx", import.meta.url),
];

const packageConsumers = [
  new URL("../src/app.ts", import.meta.url),
  new URL("../src/pages/index.astro", import.meta.url),
  new URL("../src/layouts/Shell.astro", import.meta.url),
  new URL("../src/islands/AccountGate.tsx", import.meta.url),
  new URL("../src/islands/TaskList.tsx", import.meta.url),
  new URL("../src/islands/use-tasks.ts", import.meta.url),
];

const forbidden = [
  { pattern: /jazz-tools/, name: "raw Jazz import" },
  { pattern: /(?:Shared|Service|Web)?Worker\s*\(/, name: "worker construction" },
  { pattern: /(?:wss?|https?):\/\//, name: "transport URL" },
  { pattern: /workbox/i, name: "Workbox configuration" },
  { pattern: /navigator\.|globalThis\.(?:isSecureContext|SharedWorker)/, name: "browser branch" },
];

test("author source consumes public lofi package seams and hides plumbing from product UI", async () => {
  for (
    const [path, name] of [
      ["../src/_lofi", "vendored src/_lofi runtime"],
      ["../public/sw.js", "source service worker"],
      ["../astro.config.ts", "checked-in Astro configuration"],
    ] as const
  ) {
    try {
      await Deno.stat(new URL(path, import.meta.url));
      throw new Error(`generated project still contains ${name}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  for (const file of packageConsumers) {
    const source = await Deno.readTextFile(file);
    if (/_lofi\//.test(source)) {
      throw new Error(`${file.pathname} imports vendored framework code`);
    }
  }
  for (const file of authorUiFiles) {
    const source = await Deno.readTextFile(file);
    for (const rule of forbidden) {
      if (rule.pattern.test(source)) {
        throw new Error(`${file.pathname} exposes forbidden ${rule.name}`);
      }
    }
  }
});
