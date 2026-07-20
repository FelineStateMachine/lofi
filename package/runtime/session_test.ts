// Package contract tests for account-session election behavior: the no-op
// guard, phrase-guard failure handling, the stop-sync transport guard, the
// enrollment preflight policy, and the sync-owner election guard.
import {
  assertAndRecordSyncOwnerForElection,
  createBackupPasskey,
  enableSyncBackup,
  isSyncEnrollmentError,
  performTicketEnrollment,
  stopSyncBackup,
} from "./session.ts";
import { readNamespaceState } from "./namespace-state.ts";
import { appId, setSyncElected, syncAvailable, syncElected } from "./config.ts";
import {
  anchorAppId,
  clearDeclaredSink,
  declareSinkFromTicket,
  readDeclaredSink,
} from "./data-sink.ts";
import { memoryDeviceKeyStore } from "./envelope.ts";
import { lockProvisionCapability, provisionCapabilityStatus } from "./provision.ts";
import { getRuntimeDiagnostics, runtimeRecreatedEvent } from "./runtime.ts";
import type { TicketStoreStatus } from "../schema/store.ts";
import {
  clearSyncOwner,
  isSyncOwnerError,
  readSyncOwner,
  recordSyncOwner,
  secretFingerprint,
} from "./sync-owner.ts";
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

const electionKeys = [
  `lofi:namespace-state:${appId}`,
  `lofi:managed-runtime:${appId}`,
  `lofi:migrate-local-rows:${appId}`,
  `lofi:sync-elected:${appId}`,
];

test("enabling sync without a sync location is the documented no-op", async () => {
  assert(!syncAvailable(), "this contract test requires the unconfigured local build");
  for (const key of electionKeys) localStorage.removeItem(key);
  try {
    const session = await enableSyncBackup();
    assert(!session.backedUp, "no election may be recorded without a managed Jazz app");
    assert(!session.syncing, "nothing can replicate without a managed Jazz app");
    const namespace = readNamespaceState();
    assert(
      namespace.mode === "local" && !namespace.migrateLocalRows,
      "the local namespace must remain elected — a managed election would hide every local row",
    );
    for (const key of electionKeys) {
      assert(
        localStorage.getItem(key) === null,
        `the no-op must not persist election state (wrote ${key})`,
      );
    }
  } finally {
    for (const key of electionKeys) localStorage.removeItem(key);
  }
});

const sinkKey = `lofi:data-sink:${anchorAppId}`;
const ownerKey = `lofi:sync-owner:${anchorAppId}`;

function withCleanSyncState(body: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const keys = [...electionKeys, sinkKey, ownerKey];
    const reset = () => {
      for (const key of keys) localStorage.removeItem(key);
      clearDeclaredSink();
      clearSyncOwner();
      lockProvisionCapability();
    };
    reset();
    try {
      await body();
    } finally {
      reset();
    }
  };
}

// A ticket encoded exactly as lofi-node's encodeAppTicket does (the format
// contract is pinned in data-sink_test.ts; this fixture only needs a valid
// instance).
const ticketSecret = "s".repeat(43);
const ticketAppId = "cfe52e44-7a59-4232-8dbb-bf53f27aeed6";
function encodeTicket(payload: unknown): string {
  const json = JSON.stringify(payload);
  return "lofisync1." +
    btoa(json).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
const syncTicket = encodeTicket({
  v: 1,
  appId: ticketAppId,
  url: `http://192.168.1.10:4802/t/${ticketSecret}`,
  label: "phone",
});
const provisionTicket = encodeTicket({
  v: 1,
  appId: ticketAppId,
  url: `http://192.168.1.10:4802/t/${ticketSecret}`,
  scope: "provision",
  label: "phone",
});
const derivedTicket = encodeTicket({
  v: 1,
  appId: ticketAppId,
  url: `http://192.168.1.10:4802/t/${"d".repeat(43)}`,
  scope: "sync",
  label: "phone (sync)",
});

const answering = (state: TicketStoreStatus["state"]) => (): Promise<TicketStoreStatus> =>
  Promise.resolve(
    state === "deployed"
      ? { state, appId: ticketAppId, headHash: "abc123" }
      : { state } as TicketStoreStatus,
  );

test(
  "stopping sync without a configured transport resolves and clears the election",
  withCleanSyncState(async () => {
    // The stale-tab shape: election and owner persisted, but this document's
    // runtime never configured a server, so there is no transport to detach.
    await declareSinkFromTicket(syncTicket, memoryDeviceKeyStore());
    setSyncElected(true);
    recordSyncOwner({ fingerprint: await secretFingerprint("secret-a"), user_id: "user-1" });
    let recreations = 0;
    const onRecreated = () => void (recreations += 1);
    globalThis.addEventListener(runtimeRecreatedEvent, onRecreated);
    try {
      const session = await stopSyncBackup();
      assert(!session.backedUp, "stop-sync must clear the election");
      assert(!syncElected(), "the election flag must be cleared");
      assert(readSyncOwner() === null, "stop-sync must release the sync-owner pin");
      assert(recreations === 1, "stop-sync must announce the state change");
    } finally {
      globalThis.removeEventListener(runtimeRecreatedEvent, onRecreated);
    }
  }),
);

test(
  "a no_schema preflight refuses enrollment and rolls the sink back",
  withCleanSyncState(async () => {
    let elected = 0;
    let thrown: unknown;
    try {
      await performTicketEnrollment(syncTicket, {
        keyStore: memoryDeviceKeyStore(),
        preflight: answering("no_schema"),
        elect: () => {
          elected += 1;
          return Promise.reject(new Error("elect must not run"));
        },
      });
    } catch (error) {
      thrown = error;
    }
    assert(
      isSyncEnrollmentError(thrown) && thrown.code === "no_schema",
      "the refusal must be the typed enrollment error",
    );
    assert(readDeclaredSink() === null, "the sink declaration must be rolled back");
    assert(elected === 0, "sync must not be elected on a refused enrollment");
    assert(!syncElected(), "no election flag may be written");
  }),
);

test(
  "a ticket_rejected preflight refuses a provision enrollment and holds nothing",
  withCleanSyncState(async () => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ v: 1, id: "abc", ticket: derivedTicket }), { status: 200 }),
      );
    let thrown: unknown;
    try {
      await performTicketEnrollment(provisionTicket, {
        fetcher,
        keyStore: memoryDeviceKeyStore(),
        preflight: answering("ticket_rejected"),
        elect: () => Promise.reject(new Error("elect must not run")),
      });
    } catch (error) {
      thrown = error;
    }
    assert(
      isSyncEnrollmentError(thrown) && thrown.code === "ticket_rejected",
      "the refusal must be the typed enrollment error",
    );
    assert(readDeclaredSink() === null, "the derived sink must be rolled back");
    assert(
      !provisionCapabilityStatus().held,
      "the provision capability must not be held after a refused enrollment",
    );
  }),
);

test(
  "a refused re-enrollment restores the previously declared sink",
  withCleanSyncState(async () => {
    const keyStore = memoryDeviceKeyStore();
    await declareSinkFromTicket(syncTicket, keyStore);
    let thrown: unknown;
    try {
      await performTicketEnrollment(syncTicket, {
        keyStore,
        preflight: answering("no_schema"),
        elect: () => Promise.reject(new Error("elect must not run")),
      });
    } catch (error) {
      thrown = error;
    }
    assert(isSyncEnrollmentError(thrown), "the refusal must still throw");
    const sink = readDeclaredSink();
    assert(
      sink !== null && sink.serverUrl === `http://192.168.1.10:4802/t/${ticketSecret}`,
      "the previous declaration must survive the refused re-enrollment",
    );
  }),
);

test(
  "an unreachable store enrolls anyway and records the warning",
  withCleanSyncState(async () => {
    let elected = 0;
    await performTicketEnrollment(syncTicket, {
      keyStore: memoryDeviceKeyStore(),
      preflight: answering("store_unavailable"),
      elect: () => {
        elected += 1;
        return Promise.resolve(undefined as never);
      },
    });
    assert(elected === 1, "a merely unreachable store must not block enrollment");
    assert(readDeclaredSink() !== null, "the sink declaration must be kept");
    assert(
      getRuntimeDiagnostics().storeStatus.state === "store_unavailable",
      "the warning must land in runtime diagnostics for status surfaces",
    );
  }),
);

test(
  "a deployed store enrolls a provision ticket and holds the capability",
  withCleanSyncState(async () => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ v: 1, id: "abc", ticket: derivedTicket }), { status: 200 }),
      );
    let elected = 0;
    await performTicketEnrollment(provisionTicket, {
      fetcher,
      keyStore: memoryDeviceKeyStore(),
      preflight: answering("deployed"),
      elect: () => {
        elected += 1;
        return Promise.resolve(undefined as never);
      },
    });
    assert(elected === 1, "a deployed store must elect sync");
    const sink = readDeclaredSink();
    assert(
      sink !== null && sink.serverUrl === `http://192.168.1.10:4802/t/${"d".repeat(43)}`,
      "the derived sync ticket must be the declared sink",
    );
    assert(
      provisionCapabilityStatus().held,
      "the provision capability must be held after a kept enrollment",
    );
  }),
);

test(
  "electing under a foreign owner is refused; an unclaimed election records the owner",
  withCleanSyncState(async () => {
    recordSyncOwner({ fingerprint: await secretFingerprint("owner-secret"), user_id: "user-1" });
    let thrown: unknown;
    try {
      await assertAndRecordSyncOwnerForElection(() => Promise.resolve("other-secret"));
    } catch (error) {
      thrown = error;
    }
    assert(
      isSyncOwnerError(thrown) && thrown.owner_user_id === "user-1",
      "a foreign account must be refused, naming the owner",
    );
    clearSyncOwner();
    await assertAndRecordSyncOwnerForElection(() => Promise.resolve("other-secret"));
    const record = readSyncOwner();
    assert(
      record !== null && record.fingerprint === await secretFingerprint("other-secret"),
      "an unclaimed election must record the electing account as owner",
    );
  }),
);

// In Deno there is no `location`, so enrollment fails with `origin-rejected`
// before any WebAuthn surface is touched — exactly the failure class whose
// guard handling these tests pin down.
const phraseGuardKey = `lofi:phrase-passkey:${appId}`;

test("a failed re-enrollment preserves an existing phrase guard", async () => {
  const pinned = JSON.stringify({ id: "AQIDBA" });
  localStorage.setItem(phraseGuardKey, pinned);
  try {
    const guarded = await createBackupPasskey();
    assert(guarded, "the device must still report itself guarded");
    assert(
      localStorage.getItem(phraseGuardKey) === pinned,
      "the pinned guard record must survive a failed re-enrollment",
    );
  } finally {
    localStorage.removeItem(phraseGuardKey);
  }
});

test("a failed first enrollment stores no guard and reports unguarded", async () => {
  localStorage.removeItem(phraseGuardKey);
  const guarded = await createBackupPasskey();
  assert(!guarded, "a device that never enrolled must report unguarded");
  assert(
    localStorage.getItem(phraseGuardKey) === null,
    "no guard record may be written by a failed enrollment",
  );
});
