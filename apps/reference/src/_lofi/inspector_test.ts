import { inspectorRows, type InspectorSnapshot } from "./inspector.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const snapshot: InspectorSnapshot = {
  identity: { state: "device-local key active", backup: "blocked by alpha security review" },
  storage: { driver: "persistent open", persistence: "granted", fallback: "none" },
  sync: {
    mode: "managed configured",
    transport: "live detail unavailable",
    pendingLocalWrites: 1,
    pendingGlobalWrites: 2,
    lastWrite: "local",
  },
  runtime: {
    clients: 1,
    consumers: 2,
    vendorSubscriptions: 1,
    mutationListeners: 1,
    mutationErrors: 0,
  },
  multiTab: {
    role: "unavailable",
    detail: "Jazz alpha.53 exposes no supported leader/follower signal",
  },
};

test("inspector rows retain truthful unavailable and pending states", () => {
  const rows = Object.fromEntries(inspectorRows(snapshot).map((row) => [row.label, row.value]));
  assert(rows.Transport === "live detail unavailable", "transport precision was fabricated");
  assert(rows["Pending lofi local"] === "1", "local pending work was omitted");
  assert(rows["Pending lofi global"] === "2", "global pending work was omitted");
  assert(rows["Multi-tab role"] === "unavailable", "multi-tab role was fabricated");
  assert(!JSON.stringify(rows).includes("secret"), "inspector rows exposed a secret-shaped field");
});
