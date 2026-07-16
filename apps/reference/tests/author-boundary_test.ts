const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

const authorUiFiles = [
  new URL("../src/pages/index.astro", import.meta.url),
  new URL("../src/islands/TaskList.tsx", import.meta.url),
];

const forbidden = [
  { pattern: /jazz-tools/, name: "raw Jazz import" },
  { pattern: /(?:Shared|Service|Web)?Worker\s*\(/, name: "worker construction" },
  { pattern: /(?:wss?|https?):\/\//, name: "transport URL" },
  { pattern: /workbox/i, name: "Workbox configuration" },
  { pattern: /navigator\.|globalThis\.(?:isSecureContext|SharedWorker)/, name: "browser branch" },
  {
    pattern: /_lofi\/(?:boot|config|device-capabilities|probe|pwa|runtime)/,
    name: "runtime plumbing import",
  },
];

test("author UI stays behind the lofi checklist boundary", async () => {
  for (const file of authorUiFiles) {
    const source = await Deno.readTextFile(file);
    for (const rule of forbidden) {
      if (rule.pattern.test(source)) {
        throw new Error(`${file.pathname} exposes forbidden ${rule.name}`);
      }
    }
  }
});
