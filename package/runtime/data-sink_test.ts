// Package contract tests for the runtime-declared data sink: record
// round-trip, ticket parsing (the lofi-node `lofisync1.` format contract),
// declaration guards, and how the active sync location resolves into the
// session election and database configuration.
import {
  anchorAppId,
  clearDeclaredSink,
  declareDataSink,
  declareSinkFromTicket,
  isDataSinkError,
  parseSyncTicket,
  readDeclaredSink,
} from "./data-sink.ts";
import {
  activeAppId,
  activeServerUrl,
  activeSink,
  appId,
  databaseConfig,
  setSyncElected,
  syncAvailable,
  syncElected,
  syncing,
} from "./config.ts";
import { defineLofiApp } from "./app.ts";
import { assert } from "./test-assert.ts";

defineLofiApp({
  name: "lofi-test",
  databaseName: "lofi-test",
  schema: {},
  storage: "durable",
  credentialOrigins: [],
  sync: { adapter: "jazz" },
});

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

const sinkKey = `lofi:data-sink:${anchorAppId}`;
const electionKey = `lofi:sync-elected:${appId}`;

function withCleanState(body: () => void): () => void {
  return () => {
    localStorage.removeItem(sinkKey);
    localStorage.removeItem(electionKey);
    try {
      body();
    } finally {
      localStorage.removeItem(sinkKey);
      localStorage.removeItem(electionKey);
    }
  };
}

// A ticket encoded exactly as lofi-node's encodeAppTicket does — this fixture
// doubles as the cross-repo format contract.
const ticketSecret = "s".repeat(43);
const ticketAppId = "cfe52e44-7a59-4232-8dbb-bf53f27aeed6";
function encodeTicket(payload: unknown): string {
  const json = JSON.stringify(payload);
  return "lofisync1." +
    btoa(json).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
const validTicket = encodeTicket({
  v: 1,
  appId: ticketAppId,
  url: `http://192.168.1.10:4802/t/${ticketSecret}`,
  label: "phone",
});

test(
  "a declared sink round-trips through the versioned record",
  withCleanState(() => {
    assert(readDeclaredSink() === null, "a clean device must have no declared sink");
    declareDataSink({ appId: ticketAppId, serverUrl: "https://node.example:4802", label: "home" });
    const sink = readDeclaredSink();
    assert(
      sink !== null && sink.appId === ticketAppId &&
        sink.serverUrl === "https://node.example:4802" && sink.label === "home",
      `declared sink read back as ${JSON.stringify(sink)}`,
    );
    clearDeclaredSink();
    assert(readDeclaredSink() === null, "clearing must remove the declaration");
  }),
);

test(
  "an unreadable or unversioned sink record reads as absent",
  withCleanState(() => {
    localStorage.setItem(sinkKey, "not json");
    assert(readDeclaredSink() === null, "malformed record must read as absent");
    localStorage.setItem(sinkKey, JSON.stringify({ v: 99, sink: { appId: "x", serverUrl: "y" } }));
    assert(readDeclaredSink() === null, "unknown record version must read as absent");
  }),
);

test(
  "sink declarations validate the server URL",
  withCleanState(() => {
    for (const serverUrl of ["ws://node.example/t/x", "not a url", "ftp://node.example"]) {
      try {
        declareDataSink({ appId: ticketAppId, serverUrl });
        throw new Error(`declaration accepted invalid server URL: ${serverUrl}`);
      } catch (error) {
        assert(
          isDataSinkError(error) && error.code === "invalid-server-url",
          `expected invalid-server-url for ${serverUrl}, received ${String(error)}`,
        );
      }
    }
    assert(readDeclaredSink() === null, "no rejected declaration may persist");
  }),
);

test(
  "declaring over a different sink is refused; the same store updates its label",
  withCleanState(() => {
    declareDataSink({ appId: ticketAppId, serverUrl: "https://node.example:4802" });
    try {
      declareDataSink({ appId: ticketAppId, serverUrl: "https://other.example:4802" });
      throw new Error("a different sink must not silently replace the declared one");
    } catch (error) {
      assert(
        isDataSinkError(error) && error.code === "sink-already-declared",
        `expected sink-already-declared, received ${String(error)}`,
      );
    }
    declareDataSink({
      appId: ticketAppId,
      serverUrl: "https://node.example:4802",
      label: "renamed",
    });
    assert(
      readDeclaredSink()?.label === "renamed",
      "re-declaring the same store must update the label",
    );
  }),
);

test("ticket parsing accepts the lofi-node format and rejects everything else", () => {
  const parsed = parseSyncTicket(` ${validTicket} `);
  assert(
    parsed !== null && parsed.appId === ticketAppId && parsed.label === "phone" &&
      parsed.url.endsWith(`/t/${ticketSecret}`),
    `valid ticket parsed as ${JSON.stringify(parsed)}`,
  );
  const rejected = [
    "lofisync2.abc",
    "endpointAAAA",
    encodeTicket({ v: 2, appId: ticketAppId, url: `http://h/t/${ticketSecret}` }),
    encodeTicket({ v: 1, appId: ticketAppId, url: `ws://h/t/${ticketSecret}` }),
    encodeTicket({ v: 1, appId: ticketAppId, url: "http://h/t/short" }),
    encodeTicket({ v: 1, appId: ticketAppId, url: "http://h/apps/x" }),
    encodeTicket({ v: 1, url: `http://h/t/${ticketSecret}` }),
    "lofisync1.%%%not-base64%%%",
  ];
  for (const ticket of rejected) {
    assert(parseSyncTicket(ticket) === null, `malformed ticket accepted: ${ticket.slice(0, 40)}`);
  }
});

test(
  "enrolling a ticket declares its URL verbatim as the sink",
  withCleanState(() => {
    const declared = declareSinkFromTicket(validTicket);
    assert(
      declared.serverUrl === `http://192.168.1.10:4802/t/${ticketSecret}`,
      "the ticket URL must be used verbatim — the secret path is the credential",
    );
    const sink = readDeclaredSink();
    assert(sink?.appId === ticketAppId && sink.label === "phone", "ticket fields must carry over");
    try {
      declareSinkFromTicket("lofisync1.nope");
      throw new Error("a malformed ticket must not enroll");
    } catch (error) {
      assert(
        isDataSinkError(error) && error.code === "invalid-ticket",
        `expected invalid-ticket, received ${String(error)}`,
      );
    }
  }),
);

test(
  "the active sink resolves declared over default and gates the election",
  withCleanState(() => {
    // This test build compiles no managed app, so the default sink is absent.
    assert(activeSink() === null && !syncAvailable(), "local build must start with no sink");
    assert(activeAppId() === appId, "without a sink the active app id is the anchor");
    setSyncElected(true);
    assert(!syncElected(), "election must be a no-op without a sync location");

    declareDataSink({ appId: ticketAppId, serverUrl: "https://node.example:4802" });
    const sink = activeSink();
    assert(
      sink?.source === "declared" && sink.appId === ticketAppId && syncAvailable(),
      `declared sink resolved as ${JSON.stringify(sink)}`,
    );
    assert(activeAppId() === ticketAppId, "the active app id must be the sink's");
    assert(activeServerUrl() === "https://node.example:4802", "the active URL must be the sink's");

    setSyncElected(true);
    assert(syncElected() && syncing(), "election must stand once a sink is declared");
    setSyncElected(false);
    assert(!syncing(), "clearing the election must stop replication");
  }),
);

test(
  "databaseConfig keeps the local tier on the anchor and gives managed the sink",
  withCleanState(() => {
    declareDataSink({ appId: ticketAppId, serverUrl: "https://node.example:4802" });
    setSyncElected(true);

    const local = databaseConfig("secret", "ns", "local", false);
    assert(local.appId === appId, "the local tier must stay on the anchor app id");
    assert(!("serverUrl" in local), "the local tier must not carry a server URL");
    const localDriver = local.driver as { dbName: string };
    assert(
      localDriver.dbName === `lofi-test-${appId}-ns-local`,
      `local dbName was ${localDriver.dbName} — first-boot data must remain findable`,
    );

    const managed = databaseConfig("secret", "ns");
    assert(managed.appId === ticketAppId, "the managed tier must use the sink's app id");
    assert(
      (managed as { serverUrl?: string }).serverUrl === "https://node.example:4802",
      "a connecting managed config must carry the sink URL",
    );
    const managedDriver = managed.driver as { dbName: string };
    assert(
      managedDriver.dbName === `lofi-test-${ticketAppId}-ns-managed`,
      `managed dbName was ${managedDriver.dbName} — each store gets its own namespace`,
    );
  }),
);
