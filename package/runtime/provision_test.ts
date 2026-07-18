// Provision-capability custody contract: memory-only hold, PRF sealing with
// the credential that actually evaluated it, lock/unlock ceremonies, failure
// mapping (cancelled, prf-unavailable, credential-mismatch), and the
// no-plaintext-bearer guarantee for the sealed record.
import { AuthError } from "./auth.ts";
import { anchorAppId } from "./data-sink.ts";
import { EnvelopeError, parseSealedEnvelope } from "./envelope.ts";
import {
  clearProvisionCapability,
  heldProvisionCapability,
  holdProvisionCapability,
  lockProvisionCapability,
  provisionCapabilityStatus,
  sealProvisionCapability,
  unlockProvisionCapability,
} from "./provision.ts";
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

const provisionKey = `lofi:provision:${anchorAppId}`;
const bearerUrl = `https://node.example:4802/t/${"p".repeat(43)}`;

function withCleanState(body: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    clearProvisionCapability();
    try {
      await body();
    } finally {
      clearProvisionCapability();
    }
  };
}

// A 37-byte authenticator-data buffer (rpIdHash[32] + flags + signCount[4]).
// The WebAuthn "backup eligible" (BE) flag is bit 0x08 of byte index 32.
function authenticatorData(backupEligible: boolean): ArrayBuffer {
  const bytes = new Uint8Array(37);
  if (backupEligible) bytes[32] |= 0x08;
  return bytes.buffer;
}

type PrfEval = { eval?: { first?: BufferSource } };

// A fake PRF authenticator: one credential, deterministic PRF output per eval
// salt (as a real authenticator computes it), user-verifying get() only.
function fakePrfAuthenticator(options: {
  rawId?: Uint8Array;
  portable?: boolean;
  prf?: boolean;
  cancel?: boolean;
} = {}): CredentialsContainer {
  const rawId = options.rawId ?? new Uint8Array([1, 2, 3, 4]);
  const outputs = new Map<string, Uint8Array>();
  return {
    create: () => Promise.reject(new Error("unused")),
    get: (request: CredentialRequestOptions) => {
      if (options.cancel) {
        return Promise.reject(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
      }
      const extensions = (request.publicKey?.extensions ?? {}) as { prf?: PrfEval };
      const salt = extensions.prf?.eval?.first;
      let first: ArrayBuffer | undefined;
      if (salt && options.prf !== false) {
        const key = Array.from(new Uint8Array(salt as ArrayBuffer)).join(",");
        if (!outputs.has(key)) {
          outputs.set(key, crypto.getRandomValues(new Uint8Array(32)));
        }
        // A fresh buffer per ceremony, as a real authenticator re-derives it.
        first = (outputs.get(key) as Uint8Array).slice().buffer as ArrayBuffer;
      }
      return Promise.resolve({
        rawId: rawId.buffer,
        response: { authenticatorData: authenticatorData(options.portable ?? true) },
        getClientExtensionResults: () => (first ? { prf: { results: { first } } } : {}),
      } as unknown as Credential);
    },
    store: () => Promise.reject(new Error("unused")),
    preventSilentAccess: () => Promise.resolve(),
  } as unknown as CredentialsContainer;
}

const rpId = "app.example.com";

test(
  "holding is memory-only: usable now, nothing at rest, gone on clear",
  withCleanState(() => {
    assert(heldProvisionCapability() === null, "a clean device holds nothing");
    holdProvisionCapability(bearerUrl);
    assert(heldProvisionCapability() === bearerUrl, "the held URL must read back");
    const status = provisionCapabilityStatus();
    assert(status.held && !status.sealed, "holding must not create a sealed record");
    assert(localStorage.getItem(provisionKey) === null, "holding must write nothing to storage");
    clearProvisionCapability();
    assert(heldProvisionCapability() === null, "clearing must forget the capability");
  }),
);

test(
  "sealing records the asserting credential and keeps the bearer out of storage",
  withCleanState(async () => {
    holdProvisionCapability(bearerUrl);
    const credentials = fakePrfAuthenticator({ portable: true });
    const sealed = await sealProvisionCapability({ credentials, rpId });
    assert(sealed.portable, "the portable flag must come from the asserting credential");
    const status = provisionCapabilityStatus();
    assert(
      status.held && status.sealed && status.portable === true,
      "status must reflect the seal",
    );
    const raw = localStorage.getItem(provisionKey) ?? "";
    assert(!raw.includes(bearerUrl), "the bearer URL must not reach storage in cleartext");
    assert(!raw.includes("p".repeat(43)), "the bearer secret must not reach storage in cleartext");
    assert(!raw.includes(btoa(bearerUrl)), "nor in a trivial base64 encoding");
    const record = JSON.parse(raw) as { v: number; sealed: unknown };
    assert(
      record.v === 1 && parseSealedEnvelope(record.sealed) !== null,
      "the record at rest must be a sealed envelope",
    );
  }),
);

test(
  "lock forgets memory, the ceremony unlocks, and the same salt re-derives",
  withCleanState(async () => {
    holdProvisionCapability(bearerUrl);
    const credentials = fakePrfAuthenticator({ portable: false });
    await sealProvisionCapability({ credentials, rpId });
    lockProvisionCapability();
    assert(heldProvisionCapability() === null, "locking must forget the in-memory capability");
    assert(provisionCapabilityStatus().sealed, "locking must keep the sealed record");
    const unlocked = await unlockProvisionCapability({ credentials, rpId });
    assert(unlocked === bearerUrl, "the ceremony must return the exact bearer URL");
    assert(heldProvisionCapability() === bearerUrl, "an unlock must hold the capability again");
  }),
);

test(
  "a different passkey cannot unlock the sealed record",
  withCleanState(async () => {
    holdProvisionCapability(bearerUrl);
    await sealProvisionCapability({ credentials: fakePrfAuthenticator(), rpId });
    lockProvisionCapability();
    const impostor = fakePrfAuthenticator({ rawId: new Uint8Array([9, 9, 9, 9]) });
    try {
      await unlockProvisionCapability({ credentials: impostor, rpId });
      throw new Error("an impostor credential must not unlock the record");
    } catch (error) {
      assert(
        error instanceof AuthError && error.code === "credential-mismatch",
        `expected credential-mismatch, received ${String(error)}`,
      );
    }
    assert(provisionCapabilityStatus().sealed, "the sealed record must survive the attempt");
  }),
);

test(
  "cancelled and prf-unavailable ceremonies leave state intact",
  withCleanState(async () => {
    holdProvisionCapability(bearerUrl);
    try {
      await sealProvisionCapability({ credentials: fakePrfAuthenticator({ prf: false }), rpId });
      throw new Error("a no-PRF authenticator must not seal");
    } catch (error) {
      assert(
        error instanceof AuthError && error.code === "prf-unavailable",
        `expected prf-unavailable, received ${String(error)}`,
      );
    }
    assert(localStorage.getItem(provisionKey) === null, "a failed seal must store nothing");
    assert(heldProvisionCapability() === bearerUrl, "the capability must stay held");

    await sealProvisionCapability({ credentials: fakePrfAuthenticator(), rpId });
    lockProvisionCapability();
    try {
      await unlockProvisionCapability({
        credentials: fakePrfAuthenticator({ cancel: true }),
        rpId,
      });
      throw new Error("a cancelled ceremony must not unlock");
    } catch (error) {
      assert(
        error instanceof AuthError && error.code === "cancelled",
        `expected cancelled, received ${String(error)}`,
      );
    }
    assert(heldProvisionCapability() === null, "a cancelled unlock must not hold anything");
    assert(provisionCapabilityStatus().sealed, "the sealed record must survive a cancellation");
  }),
);

test(
  "sealing without a held capability and unlocking without a record report locked",
  withCleanState(async () => {
    for (
      const attempt of [
        () => sealProvisionCapability({ credentials: fakePrfAuthenticator(), rpId }),
        () => unlockProvisionCapability({ credentials: fakePrfAuthenticator(), rpId }),
      ]
    ) {
      try {
        await attempt();
        throw new Error("an empty device must not seal or unlock");
      } catch (error) {
        assert(
          error instanceof EnvelopeError && error.code === "locked",
          `expected locked, received ${String(error)}`,
        );
      }
    }
  }),
);
