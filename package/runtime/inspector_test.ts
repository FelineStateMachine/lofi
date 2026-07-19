import { inspectorRows, type InspectorSnapshot } from "./inspector.ts";
// Package contract tests.

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const snapshot: InspectorSnapshot = {
  identity: { state: "device-local key active", backup: "recovery phrase" },
  storage: {
    driver: "persistent open",
    persistence: "granted",
    fallback: "none",
    startupFailure: "broker-incompatible",
  },
  sync: {
    mode: "managed configured",
    transport: "live detail unavailable",
    store: "no schema deployed — provision the store",
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
  lifecycle: {
    mode: "managed",
    status: "completed",
    attempts: 2,
    lastReason: "visibilitychange",
    transportDetail: "live detail unavailable",
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
  assert(
    rows["Storage startup"] === "broker-incompatible",
    "startup failure classification was omitted",
  );
  assert(
    rows.Store === "no schema deployed — provision the store",
    "the store preflight state was omitted",
  );
  assert(rows["Multi-tab role"] === "unavailable", "multi-tab role was fabricated");
  assert(!JSON.stringify(rows).includes("secret"), "inspector rows exposed a secret-shaped field");
});
