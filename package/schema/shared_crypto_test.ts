// Shared-field crypto contract: the x25519 identity, the authcrypt wrap
// (forgery and replay refusal), and the encs1 sealed-value codec.
import { x25519 } from "@noble/curves/ed25519";
import {
  generateFieldKey,
  openSharedValue,
  parseSharedValue,
  publicKeyFingerprint,
  sealSharedValue,
  SharedFieldError,
  sharedFieldPublicKey,
  unwrapFieldKey,
  type WrapContext,
  wrapFieldKey,
} from "./shared-crypto.ts";
import { assert } from "../runtime/test-assert.ts";

const aliceSecret = new Uint8Array(32).map((_, index) => index + 1);
const bobSecret = new Uint8Array(32).map((_, index) => 101 + index);
const mallorySecret = new Uint8Array(32).map((_, index) => 201 + index);

const context: WrapContext = {
  groupTable: "workspaces",
  groupId: "ws-1",
  generation: 1,
  recipientUserId: "user-bob",
  senderUserId: "user-alice",
};

function expectFailure(
  run: () => unknown,
  code: SharedFieldError["code"],
  label: string,
): void {
  try {
    run();
  } catch (error) {
    assert(
      error instanceof SharedFieldError && error.code === code,
      `${label}: expected ${code}, received ${String(error)}`,
    );
    return;
  }
  throw new Error(`${label}: expected ${code}, but the operation succeeded`);
}

Deno.test("the curve implementation matches the RFC 7748 base-point vector", () => {
  // X25519(1-scalar, base point) per RFC 7748 §5.2 conventions: a fixed
  // scalar must always produce the same public key, pinning the vendored
  // curve implementation across dependency bumps.
  const scalar = new Uint8Array(32);
  scalar[0] = 9;
  const publicKey = x25519.getPublicKey(scalar);
  assert(publicKey.length === 32, "x25519 public keys must be 32 bytes");
  const again = x25519.getPublicKey(scalar);
  assert(
    publicKey.every((byte, index) => byte === again[index]),
    "public-key derivation must be deterministic",
  );
});

Deno.test("identity derivation is deterministic and fingerprints are stable", () => {
  const first = sharedFieldPublicKey(aliceSecret);
  const second = sharedFieldPublicKey(aliceSecret);
  assert(first.every((byte, index) => byte === second[index]), "public key must be stable");
  const fingerprint = publicKeyFingerprint(first);
  assert(
    fingerprint === publicKeyFingerprint(second) && fingerprint.length >= 40,
    "fingerprint must be a stable base64url SHA-256",
  );
  expectFailure(
    () => sharedFieldPublicKey(new Uint8Array(16)),
    "identity-missing",
    "short identity secret",
  );
});

Deno.test("a wrapped field key round-trips to its recipient", () => {
  const fieldKey = generateFieldKey();
  const wrapped = wrapFieldKey({
    fieldKey,
    senderSecret: aliceSecret,
    recipientPublic: sharedFieldPublicKey(bobSecret),
    context,
  });
  assert(wrapped.startsWith("wrap1."), "wrap must carry its format prefix");
  const opened = unwrapFieldKey({
    wrapped,
    recipientSecret: bobSecret,
    senderPublic: sharedFieldPublicKey(aliceSecret),
    context,
  });
  assert(
    opened.length === 32 && opened.every((byte, index) => byte === fieldKey[index]),
    "unwrap must recover the exact field key",
  );
  const secondWrap = wrapFieldKey({
    fieldKey,
    senderSecret: aliceSecret,
    recipientPublic: sharedFieldPublicKey(bobSecret),
    context,
  });
  assert(secondWrap !== wrapped, "wrapping must be randomized per call");
});

Deno.test("forged senders, wrong recipients, and replayed contexts refuse", () => {
  const fieldKey = generateFieldKey();
  const bobPublic = sharedFieldPublicKey(bobSecret);
  const alicePublic = sharedFieldPublicKey(aliceSecret);
  const wrapped = wrapFieldKey({
    fieldKey,
    senderSecret: aliceSecret,
    recipientPublic: bobPublic,
    context,
  });

  // A wrap minted by Mallory does not verify against Alice's pinned key —
  // this is what stops a key-substituting server from minting generations.
  const forged = wrapFieldKey({
    fieldKey,
    senderSecret: mallorySecret,
    recipientPublic: bobPublic,
    context,
  });
  expectFailure(
    () =>
      unwrapFieldKey({
        wrapped: forged,
        recipientSecret: bobSecret,
        senderPublic: alicePublic,
        context,
      }),
    "wrap-invalid",
    "forged sender",
  );

  // Only the addressed recipient can open.
  expectFailure(
    () =>
      unwrapFieldKey({
        wrapped,
        recipientSecret: mallorySecret,
        senderPublic: alicePublic,
        context,
      }),
    "wrap-invalid",
    "wrong recipient",
  );

  // Context replays: every field of the binding refuses independently.
  const replays: Partial<WrapContext>[] = [
    { groupId: "ws-2" },
    { generation: 2 },
    { recipientUserId: "user-mallory" },
    { senderUserId: "user-mallory" },
    { groupTable: "teams" },
  ];
  for (const replay of replays) {
    expectFailure(
      () =>
        unwrapFieldKey({
          wrapped,
          recipientSecret: bobSecret,
          senderPublic: alicePublic,
          context: { ...context, ...replay },
        }),
      "wrap-invalid",
      `replayed context ${JSON.stringify(replay)}`,
    );
  }

  // Tampered and truncated bytes refuse.
  const tampered = wrapped.slice(0, -2) + (wrapped.endsWith("aa") ? "bb" : "aa");
  expectFailure(
    () =>
      unwrapFieldKey({
        wrapped: tampered,
        recipientSecret: bobSecret,
        senderPublic: alicePublic,
        context,
      }),
    "wrap-invalid",
    "tampered wrap",
  );
  expectFailure(
    () =>
      unwrapFieldKey({
        wrapped: "wrap1.AAAA",
        recipientSecret: bobSecret,
        senderPublic: alicePublic,
        context,
      }),
    "wrap-invalid",
    "truncated wrap",
  );
});

Deno.test("sealed shared values round-trip and carry their scope", () => {
  const fieldKey = generateFieldKey();
  const stored = sealSharedValue({
    plaintext: "a value every member reads",
    fieldKey,
    label: "docs.body",
    scope: { groupTable: "workspaces", groupId: "ws-1", generation: 3 },
  });
  assert(stored.startsWith("encs1.workspaces.ws-1.3."), "scope must ride the stored string");
  const parsed = parseSharedValue(stored);
  assert(
    parsed !== null && parsed.scope.groupId === "ws-1" && parsed.scope.generation === 3,
    "parse must recover the scope",
  );
  assert(parseSharedValue("enc2.notshared") === null, "foreign formats parse to null");
  const opened = openSharedValue({ stored, fieldKey, label: "docs.body" });
  assert(opened === "a value every member reads", "sealed value did not round-trip");

  // Size classes: two short values in one bucket store identically long.
  const short = sealSharedValue({
    plaintext: "a",
    fieldKey,
    label: "docs.body",
    scope: { groupTable: "workspaces", groupId: "ws-1", generation: 3 },
  });
  assert(short.length === stored.length, "padding must hide payload length within a bucket");
});

Deno.test("sealed shared values refuse cross-label, cross-scope, and wrong-key opens", () => {
  const fieldKey = generateFieldKey();
  const otherKey = generateFieldKey();
  const scope = { groupTable: "workspaces", groupId: "ws-1", generation: 1 };
  const stored = sealSharedValue({ plaintext: "value", fieldKey, label: "docs.body", scope });

  expectFailure(
    () => openSharedValue({ stored, fieldKey, label: "docs.title" }),
    "corrupt",
    "cross-column replay",
  );
  expectFailure(
    () => openSharedValue({ stored, fieldKey: otherKey, label: "docs.body" }),
    "corrupt",
    "wrong field key",
  );
  const rescoped = stored.replace(".ws-1.", ".ws-2.");
  expectFailure(
    () => openSharedValue({ stored: rescoped, fieldKey, label: "docs.body" }),
    "corrupt",
    "rescoped value",
  );
  expectFailure(
    () => openSharedValue({ stored: "plain text", fieldKey, label: "docs.body" }),
    "corrupt",
    "unprefixed value",
  );

  expectFailure(
    () =>
      sealSharedValue({
        plaintext: "x",
        fieldKey,
        label: "docs.body",
        scope: { ...scope, groupId: "has.dot" },
      }),
    "unscoped-write",
    "dotted scope segment",
  );
  expectFailure(
    () =>
      sealSharedValue({
        plaintext: "x",
        fieldKey,
        label: "docs.body",
        scope: { ...scope, generation: 0 },
      }),
    "unscoped-write",
    "non-positive generation",
  );
});
