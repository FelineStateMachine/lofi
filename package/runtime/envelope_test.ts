// Envelope contract tests: multi-slot seal/open, fall-through past
// unavailable protectors, slot-table tamper detection, purpose binding, and
// untrusted-record validation.
import {
  deviceKeyProtector,
  deviceKeyResolver,
  EnvelopeError,
  type EnvelopeSlot,
  memoryDeviceKeyStore,
  openEnvelope,
  parseSealedEnvelope,
  sealEnvelope,
} from "./envelope.ts";
import { assert } from "./test-assert.ts";

const payload = new TextEncoder().encode(JSON.stringify({ ticket: "/t/secret-material" }));

async function expectEnvelopeError(
  run: () => Promise<unknown>,
  code: "locked" | "corrupt",
  context: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(
      error instanceof EnvelopeError && error.code === code,
      `${context}: expected ${code}, received ${String(error)}`,
    );
    return;
  }
  throw new Error(`${context}: expected ${code}, but the envelope opened`);
}

Deno.test("a sealed envelope opens back to the payload through its device key", async () => {
  const store = memoryDeviceKeyStore();
  const sealed = await sealEnvelope("test:purpose", payload, [
    await deviceKeyProtector(store, "k1"),
  ]);
  const opened = await openEnvelope("test:purpose", sealed, deviceKeyResolver(store));
  assert(
    new TextDecoder().decode(opened) === new TextDecoder().decode(payload),
    "the opened payload must equal the sealed payload",
  );
});

Deno.test("opening falls through unavailable slots to one that answers", async () => {
  const storeA = memoryDeviceKeyStore();
  const storeB = memoryDeviceKeyStore();
  const sealed = await sealEnvelope("test:purpose", payload, [
    await deviceKeyProtector(storeA, "first"),
    await deviceKeyProtector(storeB, "second"),
  ]);
  // Only the second store is available in this context: slot one resolves to
  // null and the open must continue rather than fail.
  const opened = await openEnvelope(
    "test:purpose",
    sealed,
    (slot: EnvelopeSlot) =>
      slot.type === "device-key" && slot.keyId === "second"
        ? storeB.get("second")
        : Promise.resolve(null),
  );
  assert(opened.length === payload.length, "the fallback slot must open the envelope");
});

Deno.test("an envelope with no available protector reports locked", async () => {
  const store = memoryDeviceKeyStore();
  const sealed = await sealEnvelope("test:purpose", payload, [
    await deviceKeyProtector(store, "k1"),
  ]);
  await expectEnvelopeError(
    () => openEnvelope("test:purpose", sealed, () => Promise.resolve(null)),
    "locked",
    "no protector",
  );
  // A different store's key fails the wrap authentication and must be treated
  // as unavailable, not as corruption.
  await expectEnvelopeError(
    () => openEnvelope("test:purpose", sealed, deviceKeyResolver(memoryDeviceKeyStore())),
    "locked",
    "foreign key",
  );
});

Deno.test("tampering with the payload or the slot table is corruption", async () => {
  const store = memoryDeviceKeyStore();
  const sealed = await sealEnvelope("test:purpose", payload, [
    await deviceKeyProtector(store, "k1"),
  ]);
  const flipped = {
    ...sealed,
    ciphertext: sealed.ciphertext.startsWith("A")
      ? `B${sealed.ciphertext.slice(1)}`
      : `A${sealed.ciphertext.slice(1)}`,
  };
  await expectEnvelopeError(
    () => openEnvelope("test:purpose", flipped, deviceKeyResolver(store)),
    "corrupt",
    "flipped ciphertext",
  );
  // The slot table is authenticated data: renaming a slot's key id after the
  // fact must not go unnoticed even though the wrap itself still opens.
  const tampered = {
    ...sealed,
    slots: sealed.slots.map((slot) => ({ ...slot, keyId: "impostor" }) as EnvelopeSlot),
  };
  await expectEnvelopeError(
    () =>
      openEnvelope(
        "test:purpose",
        tampered,
        (slot) => (slot.type === "device-key" ? store.get("k1") : Promise.resolve(null)),
      ),
    "corrupt",
    "renamed slot",
  );
});

Deno.test("an envelope opens only under its own purpose", async () => {
  const store = memoryDeviceKeyStore();
  const sealed = await sealEnvelope("test:purpose", payload, [
    await deviceKeyProtector(store, "k1"),
  ]);
  await expectEnvelopeError(
    () => openEnvelope("test:other", sealed, deviceKeyResolver(store)),
    "corrupt",
    "wrong purpose",
  );
});

Deno.test("untrusted records validate strictly before any cryptography", () => {
  const invalid: unknown[] = [
    null,
    "text",
    {},
    { v: 2, purpose: "p", slots: [], iv: "a", ciphertext: "b" },
    {
      v: 1,
      purpose: "p",
      slots: [{ type: "unknown", iv: "a", wrappedDek: "b" }],
      iv: "a",
      ciphertext: "b",
    },
    {
      v: 1,
      purpose: "p",
      slots: [{ type: "device-key", iv: "a", wrappedDek: "b" }],
      iv: "a",
      ciphertext: "b",
    },
    {
      v: 1,
      purpose: "p",
      slots: [{ type: "prf", credentialId: "c", iv: "a", wrappedDek: "b" }],
      iv: "a",
      ciphertext: "b",
    },
  ];
  for (const record of invalid) {
    assert(
      parseSealedEnvelope(record) === null,
      `invalid record accepted: ${JSON.stringify(record)}`,
    );
  }
  const valid = {
    v: 1,
    purpose: "p",
    slots: [{ type: "device-key", keyId: "k", iv: "a", wrappedDek: "b" }],
    iv: "a",
    ciphertext: "b",
  };
  assert(parseSealedEnvelope(valid) !== null, "a well-formed record must validate");
});

Deno.test("sealing with no protector is refused", async () => {
  await expectEnvelopeError(
    () => sealEnvelope("test:purpose", payload, []),
    "corrupt",
    "empty protectors",
  );
});
