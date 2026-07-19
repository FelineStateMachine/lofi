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
import { SharedFieldError } from "../schema/shared-crypto.ts";
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
