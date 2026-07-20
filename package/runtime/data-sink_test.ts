// Package contract tests for the runtime-declared data sink: sealed-record
// round-trip, cleartext-record migration, ticket parsing (the lofi-node
// `lofisync1.` format contract), declaration guards, the no-plaintext-bearer
// conformance check, and how the active sync location resolves into the
// session election and database configuration.
import {
  anchorAppId,
  clearDeclaredSink,
  declareDataSink,
  declareSinkFromTicket,
  ensureDeclaredSinkRestored,
  isDataSinkError,
  parseSyncTicket,
  readDeclaredSink,
  readSinkRestoreOutcome,
  restoreDeclaredSink,
  splitTicketForEnrollment,
} from "./data-sink.ts";
import { memoryDeviceKeyStore, parseSealedEnvelope } from "./envelope.ts";
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

function withCleanState(body: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    localStorage.removeItem(sinkKey);
    localStorage.removeItem(electionKey);
    clearDeclaredSink();
    try {
      await body();
    } finally {
      localStorage.removeItem(sinkKey);
      localStorage.removeItem(electionKey);
      clearDeclaredSink();
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
  "a declared sink round-trips through the sealed record and a restore",
  withCleanState(async () => {
    assert(readDeclaredSink() === null, "a clean device must have no declared sink");
    await declareDataSink({
      appId: ticketAppId,
      serverUrl: "https://node.example:4802",
      label: "home",
    });
    const sink = readDeclaredSink();
    assert(
      sink !== null && sink.appId === ticketAppId &&
        sink.serverUrl === "https://node.example:4802" && sink.label === "home",
      `declared sink read back as ${JSON.stringify(sink)}`,
    );
    // A fresh boot re-reads storage: the sealed record must open back to the
    // same declaration.
    assert(await restoreDeclaredSink() === "restored", "the sealed record must restore");
    assert(
      readDeclaredSink()?.serverUrl === "https://node.example:4802",
      "the restored sink must match the declaration",
    );
    clearDeclaredSink();
    assert(readDeclaredSink() === null, "clearing must remove the declaration");
    assert(await restoreDeclaredSink() === "none", "clearing must remove the stored record");
  }),
);

test(
  "boot and app islands single-flight the sealed sink restore",
  withCleanState(async () => {
    const keyStore = memoryDeviceKeyStore();
    await declareDataSink({
      appId: ticketAppId,
      serverUrl: "https://node.example:4802",
      label: "boot race",
    }, keyStore);
    const stored = localStorage.getItem(sinkKey);
    assert(stored !== null, "the test sink must persist before simulating a fresh document");
    clearDeclaredSink();
    localStorage.setItem(sinkKey, stored);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const delayedStore = {
      getOrCreate: (keyId: string) => keyStore.getOrCreate(keyId),
      async get(keyId: string) {
        reads++;
        await gate;
        return await keyStore.get(keyId);
      },
    };
    const boot = ensureDeclaredSinkRestored(delayedStore);
    const island = (await import("./data-sink.ts?island=early-runtime"))
      .ensureDeclaredSinkRestored(delayedStore);
    assert(boot === island, "boot and an eager island must await the same restore promise");
    assert(
      readDeclaredSink() === null,
      "the sink must remain unavailable while restore is pending",
    );
    release();
    assert(await boot === "restored", "the shared restore must open the sealed sink");
    assert(reads === 1, `the device key was read ${reads} times instead of once`);
    assert(
      readDeclaredSink()?.label === "boot race",
      "the restored sink must precede runtime open",
    );
  }),
);

test(
  "duplicate app-island module instances share the document sink cache",
  withCleanState(async () => {
    const accountIsland = await import("./data-sink.ts?island=account");
    const deviceIsland = await import("./data-sink.ts?island=device");
    await accountIsland.declareDataSink({
      appId: ticketAppId,
      serverUrl: "https://node.example:4802",
      label: "shared island sink",
    });
    assert(
      deviceIsland.readDeclaredSink()?.label === "shared island sink",
      "a sibling island must observe the sink declared through another module instance",
    );
    deviceIsland.clearDeclaredSink();
    assert(
      accountIsland.readDeclaredSink() === null,
      "clearing through one island must update every module instance",
    );
  }),
);

test(
  "an unreadable or unversioned sink record restores as absent",
  withCleanState(async () => {
    localStorage.setItem(sinkKey, "not json");
    assert(await restoreDeclaredSink() === "none", "malformed record must restore as absent");
    assert(readDeclaredSink() === null, "malformed record must read as absent");
    localStorage.setItem(sinkKey, JSON.stringify({ v: 99, sink: { appId: "x", serverUrl: "y" } }));
    assert(await restoreDeclaredSink() === "none", "unknown record version must restore as absent");
    assert(readDeclaredSink() === null, "unknown record version must read as absent");
  }),
);

test(
  "a pre-envelope cleartext record migrates to a sealed one on restore",
  withCleanState(async () => {
    const bearerUrl = `http://192.168.1.10:4802/t/${ticketSecret}`;
    localStorage.setItem(
      sinkKey,
      JSON.stringify({ v: 1, sink: { appId: ticketAppId, serverUrl: bearerUrl, label: "phone" } }),
    );
    assert(await restoreDeclaredSink() === "migrated", "a v1 record must migrate");
    assert(readDeclaredSink()?.serverUrl === bearerUrl, "the migrated sink must carry over");
    const raw = localStorage.getItem(sinkKey) ?? "";
    assert(!raw.includes(ticketSecret), "migration must remove the bearer secret from storage");
    const record = JSON.parse(raw) as { v: number; sealed: unknown };
    assert(
      record.v === 2 && parseSealedEnvelope(record.sealed) !== null,
      "migration must persist a sealed envelope",
    );
    assert(await restoreDeclaredSink() === "restored", "the migrated record must reopen");
    assert(readDeclaredSink()?.serverUrl === bearerUrl, "the resealed sink must round-trip");
  }),
);

test(
  "a sealed record without its device key is unopenable, not destroyed",
  withCleanState(async () => {
    await declareDataSink({ appId: ticketAppId, serverUrl: "https://node.example:4802" });
    const stored = localStorage.getItem(sinkKey);
    assert(stored !== null, "the declaration must persist");
    // A store that never held the wrapping key models cleared IndexedDB with
    // surviving localStorage.
    assert(
      await restoreDeclaredSink(memoryDeviceKeyStore()) === "unopenable",
      "a missing device key must report unopenable",
    );
    assert(readDeclaredSink() === null, "an unopenable record must read as absent");
    assert(localStorage.getItem(sinkKey) === stored, "an unopenable record must be left intact");
    assert(
      readSinkRestoreOutcome() === "unopenable",
      "status surfaces must be able to distinguish unopenable from no sink at all",
    );
    assert(await restoreDeclaredSink() === "restored", "the right key must still open it");
    assert(readSinkRestoreOutcome() === "restored", "the reader must track the latest restore");
    await restoreDeclaredSink(memoryDeviceKeyStore());
    clearDeclaredSink();
    assert(
      readSinkRestoreOutcome() === "none",
      "clearing the sink must retire the unopenable outcome — re-enrollment starts clean",
    );
    await declareDataSink({ appId: ticketAppId, serverUrl: "https://node.example:4802" });
    await restoreDeclaredSink(memoryDeviceKeyStore());
    await declareDataSink({ appId: ticketAppId, serverUrl: "https://node.example:4802" });
    assert(
      readSinkRestoreOutcome() === "restored",
      "a successful re-declaration must supersede an unopenable outcome",
    );
  }),
);

test(
  "no bearer material reaches storage in cleartext or a trivial encoding",
  withCleanState(async () => {
    const bearerUrl = `http://192.168.1.10:4802/t/${ticketSecret}`;
    await declareSinkFromTicket(
      encodeTicket({ v: 1, appId: ticketAppId, url: bearerUrl, scope: "provision" }),
    );
    const base64Url = (text: string) =>
      btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const encodings = [
      ticketSecret,
      bearerUrl,
      btoa(ticketSecret),
      base64Url(ticketSecret),
      encodeURIComponent(bearerUrl),
    ];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      const value = key === null ? null : localStorage.getItem(key);
      if (!value) continue;
      for (const encoding of encodings) {
        assert(
          !value.includes(encoding),
          `bearer material found at rest under "${key}" as ${encoding.slice(0, 16)}…`,
        );
      }
    }
    const record = JSON.parse(localStorage.getItem(sinkKey) ?? "null") as {
      v: number;
      sealed: unknown;
    };
    assert(
      record?.v === 2 && parseSealedEnvelope(record.sealed) !== null,
      "the sink at rest must be a sealed envelope",
    );
    assert(await restoreDeclaredSink() === "restored", "the sealed ticket must restore");
    assert(
      readDeclaredSink()?.serverUrl === bearerUrl && readDeclaredSink()?.scope === "provision",
      "the restored declaration must return the exact ticket URL and scope",
    );
  }),
);

test(
  "sink declarations validate the server URL",
  withCleanState(async () => {
    for (const serverUrl of ["ws://node.example/t/x", "not a url", "ftp://node.example"]) {
      try {
        await declareDataSink({ appId: ticketAppId, serverUrl });
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
  withCleanState(async () => {
    await declareDataSink({ appId: ticketAppId, serverUrl: "https://node.example:4802" });
    try {
      await declareDataSink({ appId: ticketAppId, serverUrl: "https://other.example:4802" });
      throw new Error("a different sink must not silently replace the declared one");
    } catch (error) {
      assert(
        isDataSinkError(error) && error.code === "sink-already-declared",
        `expected sink-already-declared, received ${String(error)}`,
      );
    }
    await declareDataSink({
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

// The machine-readable format contract shared with lofi-node
// (docs/fixtures/app-ticket-fixtures.json there; vendored copy here). Either
// side changing the format updates the fixtures, and this test is what fails
// on drift.
test("the vendored lofi-node ticket fixtures parse exactly as the contract expects", async () => {
  const fixtures = JSON.parse(
    await Deno.readTextFile(
      new URL("../testdata/app-ticket-fixtures.json", import.meta.url),
    ),
  ) as {
    valid: { name: string; ticket: string; expect: Record<string, string> }[];
    invalid: { name: string; ticket: string }[];
  };
  for (const { name, ticket, expect } of fixtures.valid) {
    const parsed = parseSyncTicket(ticket);
    assert(parsed !== null, `valid fixture rejected: ${name}`);
    assert(
      parsed.appId === expect.appId && parsed.url === expect.url &&
        (parsed.scope ?? "sync") === expect.scope,
      `fixture "${name}" parsed as ${JSON.stringify(parsed)}, expected ${JSON.stringify(expect)}`,
    );
  }
  for (const { name, ticket } of fixtures.invalid) {
    assert(parseSyncTicket(ticket) === null, `invalid fixture accepted: ${name}`);
  }
});

test("ticket parsing accepts the lofi-node format and rejects everything else", () => {
  const parsed = parseSyncTicket(` ${validTicket} `);
  assert(
    parsed !== null && parsed.appId === ticketAppId && parsed.label === "phone" &&
      parsed.url.endsWith(`/t/${ticketSecret}`),
    `valid ticket parsed as ${JSON.stringify(parsed)}`,
  );
  const provision = parseSyncTicket(
    encodeTicket({
      v: 1,
      appId: ticketAppId,
      url: `http://h/t/${ticketSecret}`,
      scope: "provision",
    }),
  );
  assert(provision?.scope === "provision", "provision scope must parse");
  const rejected = [
    "lofisync2.abc",
    "endpointAAAA",
    encodeTicket({ v: 2, appId: ticketAppId, url: `http://h/t/${ticketSecret}` }),
    encodeTicket({ v: 1, appId: ticketAppId, url: `ws://h/t/${ticketSecret}` }),
    encodeTicket({ v: 1, appId: ticketAppId, url: "http://h/t/short" }),
    encodeTicket({ v: 1, appId: ticketAppId, url: "http://h/apps/x" }),
    encodeTicket({ v: 1, url: `http://h/t/${ticketSecret}` }),
    encodeTicket({ v: 1, appId: ticketAppId, url: `http://h/t/${ticketSecret}`, scope: "root" }),
    "lofisync1.%%%not-base64%%%",
  ];
  for (const ticket of rejected) {
    assert(parseSyncTicket(ticket) === null, `malformed ticket accepted: ${ticket.slice(0, 40)}`);
  }
});

test(
  "enrolling a ticket declares its URL verbatim as the sink",
  withCleanState(async () => {
    const declared = await declareSinkFromTicket(validTicket);
    assert(
      declared.serverUrl === `http://192.168.1.10:4802/t/${ticketSecret}`,
      "the ticket URL must be used verbatim — the secret path is the credential",
    );
    const sink = readDeclaredSink();
    assert(sink?.appId === ticketAppId && sink.label === "phone", "ticket fields must carry over");
    assert(sink.scope === undefined, "a scopeless ticket declares no explicit scope");
    try {
      await declareSinkFromTicket("lofisync1.nope");
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
  withCleanState(async () => {
    // This test build compiles no managed app, so the default sink is absent.
    assert(activeSink() === null && !syncAvailable(), "local build must start with no sink");
    assert(activeAppId() === appId, "without a sink the active app id is the anchor");
    setSyncElected(true);
    assert(!syncElected(), "election must be a no-op without a sync location");

    await declareDataSink({ appId: ticketAppId, serverUrl: "https://node.example:4802" });
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
  withCleanState(async () => {
    await declareDataSink({ appId: ticketAppId, serverUrl: "https://node.example:4802" });
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

    const tokenUrl = "https://node.example:4802/c/token";
    const overridden = databaseConfig("secret", "ns", "managed", true, () => {}, tokenUrl);
    assert(
      (overridden as { serverUrl?: string }).serverUrl === tokenUrl,
      "a possession-bound boot must connect through the exchange's token URL",
    );
  }),
);

// The scope-down exchange: a provision ticket splits into a derived sync
// ticket (declared) and the provision URL (held in memory by session.ts).
const provisionTicket = encodeTicket({
  v: 1,
  appId: ticketAppId,
  url: `http://192.168.1.10:4802/t/${ticketSecret}`,
  scope: "provision",
  label: "phone",
});
const derivedSecret = "d".repeat(43);
const derivedTicket = encodeTicket({
  v: 1,
  appId: ticketAppId,
  url: `http://192.168.1.10:4802/t/${derivedSecret}`,
  scope: "sync",
  label: "phone (sync)",
});

function fetcherReturning(status: number, body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

test("a provision ticket splits into the derived sync ticket and the held URL", async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = (input, init) => {
    requests.push(`${init?.method} ${String(input)}`);
    return Promise.resolve(
      new Response(JSON.stringify({ v: 1, id: "abc", ticket: derivedTicket }), { status: 200 }),
    );
  };
  const split = await splitTicketForEnrollment(provisionTicket, fetcher);
  assert(split.sinkTicket === derivedTicket, "the derived sync ticket must become the sink");
  assert(
    split.provisionUrl === `http://192.168.1.10:4802/t/${ticketSecret}`,
    "the provision URL must be returned for in-memory custody",
  );
  assert(
    requests.length === 1 &&
      requests[0] === `POST http://192.168.1.10:4802/t/${ticketSecret}/derive-sync-ticket`,
    `the exchange must POST the derive endpoint once, sent: ${requests.join("; ")}`,
  );
});

test("exchange failures fall back to enrolling the ticket as pasted", async () => {
  const fallbacks: Array<typeof fetch> = [
    fetcherReturning(401, { error: "invalid_ticket" }),
    fetcherReturning(404, "not found"),
    fetcherReturning(200, { ticket: 7 }),
    fetcherReturning(200, { v: 1, id: "abc", ticket: "lofisync1.nope" }),
    fetcherReturning(200, {
      v: 1,
      id: "abc",
      ticket: encodeTicket({
        v: 1,
        appId: "11111111-2222-3333-4444-555555555555",
        url: `http://h/t/${derivedSecret}`,
        scope: "sync",
      }),
    }),
    fetcherReturning(200, {
      v: 1,
      id: "abc",
      ticket: encodeTicket({
        v: 1,
        appId: ticketAppId,
        url: `http://h/t/${derivedSecret}`,
        scope: "provision",
      }),
    }),
    () => Promise.reject(new Error("network down")),
  ];
  for (const fetcher of fallbacks) {
    const split = await splitTicketForEnrollment(provisionTicket, fetcher);
    assert(
      split.sinkTicket === provisionTicket && split.provisionUrl === null,
      "an unusable exchange must fall back to the pasted ticket",
    );
  }
});

test("sync-scoped and malformed tickets never touch the exchange", async () => {
  let calls = 0;
  const fetcher: typeof fetch = () => {
    calls++;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  for (const ticket of [validTicket, "lofisync1.nope", "not a ticket"]) {
    const split = await splitTicketForEnrollment(ticket, fetcher);
    assert(
      split.sinkTicket === ticket && split.provisionUrl === null,
      "a non-provision paste must pass through unchanged",
    );
  }
  assert(calls === 0, "the exchange endpoint must not be called for non-provision tickets");
});

test("offering a device key binds the derived ticket; old nodes fall back to bearer", async () => {
  const bodies: string[] = [];
  const bindingFetcher: typeof fetch = (_input, init) => {
    bodies.push(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({ v: 1, id: "bound-id", ticket: derivedTicket, pop: true }),
        { status: 200 },
      ),
    );
  };
  const deviceKey = { alg: "ES256" as const, spki: "test-spki" };
  const bound = await splitTicketForEnrollment(provisionTicket, bindingFetcher, deviceKey);
  assert(
    bound.pop !== null && bound.pop.ticketId === "bound-id",
    "a pop:true response must record the binding with its ticket id",
  );
  assert(
    bodies.length === 1 && JSON.parse(bodies[0]).devicePublicKey.spki === "test-spki",
    "the derive request must carry the offered device key",
  );

  // A node predating the field answers without `pop`: bearer fallback.
  const legacyFetcher: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ v: 1, id: "abc", ticket: derivedTicket }), { status: 200 }),
    );
  const legacy = await splitTicketForEnrollment(provisionTicket, legacyFetcher, deviceKey);
  assert(
    legacy.pop === null && legacy.sinkTicket === derivedTicket,
    "a keyless response must enroll the derived ticket as pure bearer",
  );
});

test(
  "a possession binding declared with the ticket survives the sealed round-trip",
  withCleanState(async () => {
    await declareSinkFromTicket(derivedTicket, undefined, { ticketId: "bound-id" });
    assert(
      readDeclaredSink()?.pop?.ticketId === "bound-id",
      "the declaration must carry the binding",
    );
    assert(await restoreDeclaredSink() === "restored", "the sealed record must restore");
    assert(
      readDeclaredSink()?.pop?.ticketId === "bound-id",
      "the restored declaration must keep the binding",
    );
    assert(
      activeSink()?.pop?.ticketId === "bound-id",
      "the active sink must expose the binding so boot runs the exchange",
    );
  }),
);
