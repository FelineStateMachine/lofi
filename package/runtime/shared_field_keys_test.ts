// Shared-field identity custody: deterministic derivation with key
// separation, trust-on-first-sight pinning, and directory self-publication
// against a stub database.
import {
  clearFingerprintPins,
  deriveSharedFieldIdentity,
  directoryPublicKey,
  ensureDirectoryEntry,
  pinnedFingerprint,
  trustPeerKey,
  verifyAndPinFingerprint,
} from "./shared-field-keys.ts";
import { generateFieldKey, SharedFieldError, wrapFieldKey } from "../schema/shared-crypto.ts";
import {
  clearSharedFieldIdentity,
  clearSharedFieldKeys,
  getSharedFieldKey,
  installSharedFieldIdentity,
  sharedKeyScope,
} from "../schema/shared-keyring.ts";
import { startSharedFieldKeyWatcher } from "./shared-field-keys.ts";
import { assert } from "./test-assert.ts";

const APP = "pin-test-app";

Deno.test("identity derivation is deterministic and separated from the column key", async () => {
  const first = await deriveSharedFieldIdentity("account-secret-a");
  const second = await deriveSharedFieldIdentity("account-secret-a");
  assert(
    first.fingerprint === second.fingerprint &&
      first.publicKey.every((byte, index) => byte === second.publicKey[index]),
    "the same account secret must derive the same identity",
  );
  const other = await deriveSharedFieldIdentity("account-secret-b");
  assert(other.fingerprint !== first.fingerprint, "distinct secrets must derive distinct keys");

  // Key separation: the x25519 secret must differ from the encrypted-column
  // master key derived from the same account secret (distinct HKDF info).
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("account-secret-a"),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const columnKey = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: new TextEncoder().encode("lofi:encrypted-columns:v1"),
      },
      material,
      256,
    ),
  );
  assert(
    !first.secret.every((byte, index) => byte === columnKey[index]),
    "the identity secret must not equal the column master key",
  );
});

Deno.test("pins are trust-on-first-sight and refuse silent substitution", () => {
  clearFingerprintPins(APP);
  try {
    assert(pinnedFingerprint(APP, "alice") === undefined, "no pin before first sight");
    assert(verifyAndPinFingerprint(APP, "alice", "fp-1"), "first sight must pin");
    assert(pinnedFingerprint(APP, "alice") === "fp-1", "the pin must persist");
    assert(verifyAndPinFingerprint(APP, "alice", "fp-1"), "a matching key must verify");
    assert(!verifyAndPinFingerprint(APP, "alice", "fp-2"), "a changed key must refuse");
    assert(pinnedFingerprint(APP, "alice") === "fp-1", "a refusal must not move the pin");
    trustPeerKey(APP, "alice", "fp-2");
    assert(verifyAndPinFingerprint(APP, "alice", "fp-2"), "explicit trust must re-pin");
  } finally {
    clearFingerprintPins(APP);
  }
});

Deno.test("directory rows decode strictly", async () => {
  const identity = await deriveSharedFieldIdentity("account-secret-a");
  let stored = "";
  {
    let binary = "";
    for (const byte of identity.publicKey) binary += String.fromCharCode(byte);
    stored = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }
  const decoded = directoryPublicKey({ algo: "x25519-v1", public_key: stored });
  assert(
    decoded.every((byte, index) => byte === identity.publicKey[index]),
    "a published key must decode to the derived key",
  );
  for (
    const [row, label] of [
      [{ algo: "rsa", public_key: stored }, "unsupported algorithm"],
      [{ algo: "x25519-v1", public_key: "AAAA" }, "truncated key"],
    ] as const
  ) {
    let refused = false;
    try {
      directoryPublicKey(row);
    } catch (error) {
      refused = error instanceof SharedFieldError && error.code === "wrap-invalid";
    }
    assert(refused, `${label} must refuse with wrap-invalid`);
  }
});

Deno.test("directory publication inserts once and reports conflicts", async () => {
  const identity = await deriveSharedFieldIdentity("account-secret-a");
  const rows: Record<string, unknown>[] = [];
  const db = {
    all: (_query: unknown) => Promise.resolve([...rows]),
    insert: (_table: unknown, values: Record<string, unknown>) => ({
      wait: (_options: { tier: "local" | "global" }) => {
        rows.push(values);
        return Promise.resolve(values);
      },
    }),
  };
  const directory = { where: (condition: Record<string, unknown>) => condition };

  const first = await ensureDirectoryEntry({ db, directory, userId: "alice", identity });
  assert(first.state === "published", "first boot must publish");
  assert(
    rows.length === 1 && rows[0].algo === "x25519-v1" &&
      rows[0].fingerprint === identity.fingerprint,
    "the published row must carry the key material",
  );

  const second = await ensureDirectoryEntry({ db, directory, userId: "alice", identity });
  assert(second.state === "existing" && rows.length === 1, "a later boot must not republish");

  rows[0] = { ...rows[0], public_key: "tampered-key" };
  const third = await ensureDirectoryEntry({ db, directory, userId: "alice", identity });
  assert(
    third.state === "self-key-conflict",
    "a mismatched self row must surface as a conflict, never be overwritten",
  );
  assert(rows.length === 1 && rows[0].public_key === "tampered-key", "no overwrite occurred");
});

Deno.test("the watcher unwraps valid wraps and refuses forgeries and substitutions", async () => {
  clearFingerprintPins("watch-app");
  clearSharedFieldKeys();
  try {
    const alice = await deriveSharedFieldIdentity("alice-secret");
    const bob = await deriveSharedFieldIdentity("bob-secret");
    const mallory = await deriveSharedFieldIdentity("mallory-secret");
    installSharedFieldIdentity(bob);

    const fieldKey = generateFieldKey();
    const context = {
      groupTable: "workspaces",
      groupId: "ws-1",
      generation: 1,
      recipientUserId: "bob",
      senderUserId: "alice",
    };
    const validWrap = wrapFieldKey({
      fieldKey,
      senderSecret: alice.secret,
      recipientPublic: bob.publicKey,
      context,
    });
    const forgedWrap = wrapFieldKey({
      fieldKey: generateFieldKey(),
      senderSecret: mallory.secret,
      recipientPublic: bob.publicKey,
      context: { ...context, generation: 2 },
    });

    const encode = (bytes: Uint8Array) => {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    };
    const directoryRows = [{
      user_id: "alice",
      algo: "x25519-v1",
      public_key: encode(alice.publicKey),
    }];
    const wrapRows = [
      {
        groupId: "ws-1",
        recipient_user_id: "bob",
        sender_user_id: "alice",
        generation: 1,
        wrapped_key: validWrap,
        sender_fingerprint: alice.fingerprint,
      },
      // Forged: Mallory minted it but the row claims Alice sent it.
      {
        groupId: "ws-1",
        recipient_user_id: "bob",
        sender_user_id: "alice",
        generation: 2,
        wrapped_key: forgedWrap,
        sender_fingerprint: alice.fingerprint,
      },
    ];

    const delivery: { fn: ((delta: { all: unknown[] }) => void) | null } = { fn: null };
    const db = {
      subscribeAll: (_query: unknown, onDelta: (delta: { all: unknown[] }) => void) => {
        delivery.fn = onDelta;
        return () => {};
      },
      all: (_query: unknown) => Promise.resolve([...directoryRows]),
    };
    const alerts: Array<{ code: string; userId: string }> = [];
    const stop = startSharedFieldKeyWatcher({
      db,
      appId: "watch-app",
      userId: "bob",
      configs: [{
        label: "docs.body",
        kind: "text",
        group: "workspaces",
        groupIdColumn: "workspaceId",
        keys: "workspaceFieldKeys",
        directory: "keyDirectory",
      }],
      findTable: (name) => ({ where: (condition) => ({ name, condition }) }),
      onAlert: (alert) => alerts.push(alert),
    });
    assert(delivery.fn !== null, "the watcher must subscribe to the key table");
    delivery.fn!({ all: wrapRows });
    // Unwrap resolution is async (directory fetch); yield until settled.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const scope = sharedKeyScope("workspaces", "ws-1");
    const installed = getSharedFieldKey(scope, 1);
    assert(
      installed !== null && installed.every((byte, index) => byte === fieldKey[index]),
      "the valid wrap must install its field key",
    );
    assert(getSharedFieldKey(scope, 2) === null, "the forged wrap must install nothing");
    assert(
      alerts.some((alert) => alert.code === "wrap-invalid" && alert.userId === "alice"),
      "the forged wrap must surface an alert",
    );

    // A substituted directory key refuses before any unwrap: Alice's pin is
    // set from the valid round; swap the directory to Mallory's key.
    directoryRows[0] = {
      user_id: "alice",
      algo: "x25519-v1",
      public_key: encode(mallory.publicKey),
    };
    alerts.length = 0;
    delivery.fn!({
      all: [{
        groupId: "ws-1",
        recipient_user_id: "bob",
        sender_user_id: "alice",
        generation: 3,
        wrapped_key: validWrap,
        sender_fingerprint: mallory.fingerprint,
      }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(
      alerts.some((alert) => alert.code === "peer-key-changed"),
      "a substituted directory key must surface peer-key-changed",
    );
    assert(getSharedFieldKey(scope, 3) === null, "a substituted key must install nothing");
    stop();
  } finally {
    clearFingerprintPins("watch-app");
    clearSharedFieldKeys();
    clearSharedFieldIdentity();
  }
});
